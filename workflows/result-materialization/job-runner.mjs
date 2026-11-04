#!/usr/bin/env node
import { readFile, statfs, writeFile } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import path from "node:path";
import { canonicalJson } from "./lib/common.mjs";
import { writeJobStatus } from "./lib/background-job.mjs";
import { materialize } from "./lib/materialize.mjs";

import { summarizeReconstructionError } from "./lib/reconstruction.mjs";

const jobDir = path.resolve(process.argv[2] ?? "");
let job;
let resourceTimer;
let progressQueue = Promise.resolve();

try {
  job = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  const startedAt = new Date().toISOString();
  let lastProgressWriteAt = 0;
  let lastProgressPhase = null;
  let latestProgress = null;
  let latestResources = null;
  const startedAtMs = Date.now();
  let phaseStartedAtMs = startedAtMs;
  await writeJobStatus(jobDir, {
    state: "running",
    phase: "preparing",
    createdAt: job.createdAt,
    startedAt,
    updatedAt: startedAt,
    progress: null,
  });
  emit({ event: "job_started", jobId: job.jobId, time: startedAt });
  const sampleResources = async () => {
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
    const phaseElapsedSeconds = Math.max(
      0,
      (Date.now() - phaseStartedAtMs) / 1000,
    );
    const completed = latestProgress?.completed;
    const total = latestProgress?.total;
    const itemsPerSecond =
      Number.isFinite(completed) && phaseElapsedSeconds > 0
        ? completed / phaseElapsedSeconds
        : null;
    let diskFreeBytes = null;
    try {
      const disk = await statfs(path.dirname(job.outputPath), { bigint: true });
      diskFreeBytes = Number(disk.bavail * disk.bsize);
    } catch {}
    return {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      maxRssBytes: usage.maxRSS * 1024,
      userCpuMicros: usage.userCPUTime,
      systemCpuMicros: usage.systemCPUTime,
      elapsedSeconds,
      phaseElapsedSeconds,
      itemsPerSecond,
      etaSeconds:
        Number.isFinite(total) && itemsPerSecond > 0
          ? Math.max(0, (total - completed) / itemsPerSecond)
          : null,
      outputBytes: latestProgress?.outputBytes ?? null,
      diskFreeBytes,
    };
  };
  resourceTimer = setInterval(() => {
    progressQueue = progressQueue.then(async () => {
      try {
        const time = new Date().toISOString();
        latestResources = await sampleResources();
        emit({
          event: "resource_sample",
          jobId: job.jobId,
          time,
          phase: lastProgressPhase ?? "preparing",
          ...latestResources,
        });
        const current = JSON.parse(
          await readFile(path.join(jobDir, "status.json"), "utf8"),
        );
        await writeJobStatus(jobDir, {
          ...current,
          updatedAt: time,
          resources: latestResources,
        });
      } catch {}
    });
  }, 5000);
  resourceTimer.unref();
  const recordProgress = async (progress) => {
    latestProgress = progress;
    const now = Date.now();
    const phaseChanged = progress.phase !== lastProgressPhase;
    if (phaseChanged) phaseStartedAtMs = now;
    const phaseCompleted =
      Number.isInteger(progress.total) && progress.completed === progress.total;
    if (!phaseChanged && !phaseCompleted && now - lastProgressWriteAt < 1000) {
      return;
    }
    lastProgressWriteAt = now;
    lastProgressPhase = progress.phase;
    const updatedAt = new Date().toISOString();
    const resources = await sampleResources();
    latestResources = resources;
    emit({
      event: "progress",
      jobId: job.jobId,
      time: updatedAt,
      ...progress,
      resources,
    });
    try {
      await writeJobStatus(jobDir, {
        state: "running",
        phase: progress.phase,
        createdAt: job.createdAt,
        startedAt,
        updatedAt,
        progress,
        resources,
      });
    } catch (error) {
      emit({
        event: "status_write_failed",
        jobId: job.jobId,
        time: new Date().toISOString(),
        message: error.message,
      });
    }
  };
  const onProgress = (progress) => {
    progressQueue = progressQueue.then(() => recordProgress(progress));
    return progressQueue;
  };
  const request = job.request;
  const result = await materialize({
    intakeDir: request.intakeDir,
    outDir: request.outDir,
    artifactRoot: request.artifactRoot,
    processUuids: request.processUuids,
    outputType: request.outputType,
    resultProcessLayer: request.resultProcessLayer,
    firstGeneration: request.firstGeneration,
    previousManifestPath: request.previousManifestPath,
    concurrency: request.concurrency,
    onProgress,
  });
  const completedAt = new Date().toISOString();
  clearInterval(resourceTimer);
  await progressQueue;
  const payload = {
    ok: true,
    jobId: job.jobId,
    output: result.path,
    manifest: path.join(result.path, "materialization-manifest.json"),
    request: result.request,
    summary: result.summary,
    disposition: result.disposition,
    pathPolicy: result.pathPolicy,
    artifactIdentity: result.artifactIdentity,
    completedAt,
  };
  await writeFile(job.paths.result, canonicalJson(payload), { flag: "wx" });
  await writeFile(job.paths.exitCode, "0\n", { flag: "wx" });
  await writeJobStatus(jobDir, {
    state: "succeeded",
    phase: "completed",
    createdAt: job.createdAt,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    progress: { phase: "completed", ...result.summary },
    resources: latestResources,
  });
  emit({
    event: "job_completed",
    jobId: job.jobId,
    time: completedAt,
    ...result.summary,
  });
} catch (error) {
  if (resourceTimer) clearInterval(resourceTimer);
  await progressQueue.catch(() => {});
  const failedAt = new Date().toISOString();
  const payload = {
    ok: false,
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    failedAt,
  };
  const summary = {
    ...payload.error,
    details: summarizeReconstructionError(error),
  };
  emit({
    event: "job_failed",
    jobId: job?.jobId ?? null,
    time: failedAt,
    ...summary,
  });
  try {
    await writeFile(path.join(jobDir, "result.json"), canonicalJson(payload), {
      flag: "wx",
    });
    await writeFile(path.join(jobDir, "exit-code"), "1\n", { flag: "wx" });
    await writeJobStatus(jobDir, {
      state: "failed",
      phase: "failed",
      createdAt: job?.createdAt ?? failedAt,
      updatedAt: failedAt,
      failedAt,
      error: summary,
    });
  } catch {}
  process.exitCode = 1;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
