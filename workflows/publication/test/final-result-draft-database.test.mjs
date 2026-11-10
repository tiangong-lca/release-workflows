import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { candidate } from "./fixtures/final-reader.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
import { createFinalResultRegistry } from "../adapters/final-result-registry.mjs";
import { createFinalResultPublication } from "../adapters/final-result-publication.mjs";
import {
  inspectFinalResultStorage,
  executeFinalResultStorage,
} from "../lib/final-result-storage.mjs";
import {
  buildFinalResultPublicationPlan,
  prepareFinalResultPublication,
} from "../lib/final-result-publication-plan.mjs";
import { runFinalResultPublicationCommand } from "../lib/final-result-publication-command.mjs";
import path from "node:path";
const exec = promisify(execFile);
const id = (n) => `96142000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test(
  "small actual Candidates use real local PostgREST version conflicts, atomic replacement, lost ACK and retained history without publication",
  {
    skip:
      !process.env.RELEASE_DRAFT_TEST_ANON_KEY ||
      !process.env.RELEASE_DRAFT_TEST_JWT_SECRET ||
      !process.env.RELEASE_PAIR_TIDAS_BIN,
    timeout: 120000,
  },
  async (t) => {
    const meta = JSON.parse(
      (await exec("docker", ["inspect", "supabase_db_draft961"])).stdout,
    )[0];
    assert.equal(meta.Name, "/supabase_db_draft961");
    assert.equal(meta.Config.Labels["com.supabase.cli.project"], "draft961");
    const connectionString =
      "postgres://postgres:postgres@127.0.0.1:61062/postgres";
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    t.after(() => owner.end());
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from auth.users where id=$1",
          [id(1)],
        )
      ).rows[0].n,
      0,
      "owner reset required",
    );
    await owner.query("begin");
    await owner.query(
      "insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated','draft-replacement@example.invalid','{}','{}',now(),now())",
      [id(1)],
    );
    await owner.query(
      "insert into private.users(id,raw_user_meta_data) values($1,'{}')",
      [id(1)],
    );
    await owner.query(
      "insert into private.teams(id,json,rank,is_public) values('00000000-0000-0000-0000-000000000000','{}',0,false) on conflict(id) do nothing",
    );
    await owner.query(
      "insert into private.roles(user_id,team_id,role) values($1,'00000000-0000-0000-0000-000000000000','data_product_manager')",
      [id(1)],
    );
    await owner.query("commit");
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        role: "authenticated",
        sub: id(1),
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const accessToken =
      `${header}.${body}.` +
      createHmac("sha256", process.env.RELEASE_DRAFT_TEST_JWT_SECRET)
        .update(`${header}.${body}`)
        .digest("base64url");
    let dropReplacement = true,
      replacementCalls = 0;
    const proxy = createServer(async (req, res) => {
      try {
        assert.ok(req.url.startsWith("/rest/v1/rpc/"));
        const chunks = [];
        for await (const b of req) chunks.push(b);
        const upstream = await fetch("http://127.0.0.1:61061" + req.url, {
          method: "POST",
          redirect: "error",
          headers: {
            apikey: req.headers.apikey,
            Authorization: req.headers.authorization,
            "Content-Profile": "api",
            "Content-Type": "application/json",
          },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(15000),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (req.url.endsWith("cmd_final_result_release_replace_v2")) {
          replacementCalls++;
          if (dropReplacement && upstream.ok && JSON.parse(bytes).ok) {
            dropReplacement = false;
            res.destroy();
            return;
          }
        }
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(bytes);
      } catch {
        res.destroy();
      }
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    t.after(async () => {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    });
    const env = {
      TIANGONG_LCA_API_BASE_URL: `http://127.0.0.1:${proxy.address().port}`,
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY:
        process.env.RELEASE_DRAFT_TEST_ANON_KEY,
      TIANGONG_LCA_ACCESS_TOKEN: accessToken,
    };
    const actor = createFinalResultPublication({
      endpoint: env.TIANGONG_LCA_API_BASE_URL,
      publishableKey: env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
      accessToken,
    });
    const registry = createFinalResultRegistry({ connectionString });
    t.after(() => registry.close());
    const store = await storageFixture(t, {
      databaseTargetHash: registry.databaseTargetHash,
    });
    const first = await candidate(t, { releaseVersion: "2099.11.142" });
    const second = await candidate(t, {
      releaseVersion: "2099.11.142",
      amount: "8.5",
      previousResult: first.result,
    });
    for (const sample of [first, second]) {
      const inspected = await inspectFinalResultStorage({
        candidateDir: sample.candidateDir,
        targetHash: store.store.targetHash,
      });
      await executeFinalResultStorage({
        candidateDir: sample.candidateDir,
        confirmPlanHash: inspected.planHash,
        objectStore: store.store,
        registry,
      });
    }
    assert.notEqual(
      second.result.version,
      first.result.version,
      "changed Result content follows upstream version policy",
    );
    const build = (sample, runId, extra = {}) =>
      buildFinalResultPublicationPlan({
        candidateDir: sample.candidateDir,
        targetHash: store.store.targetHash,
        actor,
        releaseRunId: runId,
        reason: "synthetic replacement qualification",
        ...extra,
      });
    const old = await build(first, id(2));
    await prepareFinalResultPublication({
      local: old.local,
      confirmLocalPlanHash: old.localPlanHash,
      actor,
      record: async () => {},
    });
    const before = (
      await owner.query(
        "select md5(jsonb_agg(to_jsonb(m) order by result_id)::text) digest from private.final_result_release_members m where release_run_id=$1",
        [id(2)],
      )
    ).rows[0].digest;
    await assert.rejects(
      build(second, id(3)),
      (e) =>
        e.code === "final_result_release_version_conflict" &&
        e.details.versionState.occupant.releaseRunId === id(2),
    );
    assert.equal(await actor.run(id(3)), null);
    const replacement = await build(second, id(3), {
      replaceDraftRunId: id(2),
    });
    assert.notEqual(replacement.plan.candidateSha256, old.plan.candidateSha256);
    const events = [];
    const args = {
      local: replacement.local,
      confirmLocalPlanHash: replacement.localPlanHash,
      actor,
      record: async (e) => events.push(e),
    };
    const receipt = await prepareFinalResultPublication(args);
    assert.equal(receipt.status, "prepared");
    assert.deepEqual(receipt.replacement, replacement.local.replacement);
    assert.equal(
      replacementCalls,
      1,
      "lost ACK must recover from exact readback, not resend replacement",
    );
    await prepareFinalResultPublication(args);
    assert.equal(replacementCalls, 1);
    const history = await actor.draft(id(2));
    assert.equal(history.replacedByReleaseRunId, id(3));
    const next = await actor.draft(id(3));
    assert.equal(next.replacesReleaseRunId, id(2));
    assert.equal(next.replacesPublishPlanHash, old.local.publishPlanHash);
    const after = (
      await owner.query(
        "select md5(jsonb_agg(to_jsonb(m) order by result_id)::text) digest from private.final_result_release_members m where release_run_id=$1",
        [id(2)],
      )
    ).rows[0].digest;
    assert.equal(after, before, "old exact member bindings retained");
    assert.equal((await actor.run(id(2))).selectionSealed, true);
    await assert.rejects(
      prepareFinalResultPublication({
        local: old.local,
        confirmLocalPlanHash: old.localPlanHash,
        actor,
        record: async () => {},
      }),
      { code: "final_publication_draft_retired" },
    );
    await assert.rejects(build(second, id(4), { replaceDraftRunId: id(2) }), {
      code: "final_result_draft_replacement_conflict",
    });
    const observed = await runFinalResultPublicationCommand(
      "status",
      { "run-id": id(2), "out-dir": path.join(first.input.root, "old-status") },
      { env },
    );
    assert.equal(observed.draftHistory.replacedByReleaseRunId, id(3));
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.lca_release_publications",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.lca_release_approvals",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.command_audit_log where command='cmd_final_result_release_replace_v2' and target_id=$1",
          [id(3)],
        )
      ).rows[0].n,
      1,
    );
    assert.ok(!JSON.stringify(receipt).includes(accessToken));
  },
);
