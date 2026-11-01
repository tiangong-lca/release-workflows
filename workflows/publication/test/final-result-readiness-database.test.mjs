import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { canonicalJson } from "../lib/common.mjs";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidate, worker, id } from "./fixtures/final-reader.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
import { createFinalResultIdentityStore } from "../../release-candidate/lib/final-result-identity.mjs";
import { createFinalResultRegistry } from "../adapters/final-result-registry.mjs";
import { createFinalResultPublication } from "../adapters/final-result-publication.mjs";
import {
  buildFinalResultPublicationPlan,
  prepareFinalResultPublication,
} from "../lib/final-result-publication-plan.mjs";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
import {
  inspectFinalResultStorage,
  executeFinalResultStorage,
} from "../lib/final-result-storage.mjs";
import { verifyFinalResultReadiness } from "../lib/final-result-readiness.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");

test(
  "actual Candidate/Worker/CLI readiness and explicit synthetic actor lifecycle qualify in isolated PostgreSQL",
  {
    skip:
      !process.env.RELEASE_READINESS_TEST_CONN ||
      !process.env.RELEASE_PAIR_TIDAS_BIN ||
      !process.env.RELEASE_QUERY_WORKER_BIN,
  },
  async (t) => {
    const connectionString = process.env.RELEASE_READINESS_TEST_CONN,
      url = new URL(connectionString);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "61432");
    assert.equal(url.username, "postgres");
    assert.equal(url.pathname, "/postgres");
    assert.equal(url.search, "");
    const { stdout } = await promisify(execFile)("docker", [
      "inspect",
      "supabase_db_hdf5-final-879",
    ]);
    assert.equal(
      JSON.parse(stdout)[0].Config.Labels["com.supabase.cli.project"],
      "hdf5-final-879",
    );
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    t.after(() => owner.end());
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.final_result_query_runtime_head",
        )
      ).rows[0].n,
      0,
      "owner reset required",
    );
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.final_result_identities",
        )
      ).rows[0].n,
      0,
      "owner reset required",
    );
    const registry = createFinalResultRegistry({ connectionString });
    t.after(() => registry.close());
    const f = await candidate(t, {
      createAuthority: () =>
        createFinalResultIdentityStore({ connectionString }),
    });
    const storage = await storageFixture(t, {
      databaseTargetHash: registry.databaseTargetHash,
    });
    const inspected = await inspectFinalResultStorage({
      candidateDir: f.candidateDir,
      targetHash: storage.store.targetHash,
    });
    await executeFinalResultStorage({
      candidateDir: f.candidateDir,
      confirmPlanHash: inspected.planHash,
      objectStore: storage.store,
      registry,
    });
    const runtime = await worker(t, f, storage);
    const actorId = id(401),
      runId = id(402),
      revision = id(403),
      verificationId = id(404);
    await owner.query("begin");
    await owner.query(
      "insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated','readiness-integration@example.invalid','{}','{}',now(),now())",
      [actorId],
    );
    await owner.query(
      "insert into private.users(id,raw_user_meta_data) values($1,'{}')",
      [actorId],
    );
    await owner.query(
      "insert into private.teams(id,json,rank,is_public) values('00000000-0000-0000-0000-000000000000','{\"name\":\"synthetic\"}',0,false) on conflict(id) do nothing",
    );
    await owner.query(
      "insert into private.roles(user_id,team_id,role) values($1,'00000000-0000-0000-0000-000000000000','data_product_manager')",
      [actorId],
    );
    await owner.query("set local role service_role");
    await owner.query(
      "select api.svc_result_query_runtime_configure_v2($1,null,$2,$3,true,'synthetic local qualification')",
      [revision, storage.store.targetHash, runtime.readerSha256],
    );
    await owner.query("commit");
    const members = f.loaded.queryCatalog.results
      .map(({ uuid, version }) => ({ uuid, version }))
      .sort((a, b) =>
        `${a.uuid}@${a.version}` < `${b.uuid}@${b.version}` ? -1 : 1,
      );
    const selectionHash = sha(
      `tiangong.final-result-selection.v1\n${sha(members.map((r) => `${r.uuid}@${r.version}\n`).join(""))}\n`,
    );
    const planText = canonicalJson({
      schemaVersion: "tiangong.final-result-publish-plan.v2",
      releaseRunId: runId,
      releaseVersion: "2026.11.0",
      candidateSha256: inspected.plan.candidateHash,
      targetHash: storage.store.targetHash,
      selectionHash,
      selectionCount: members.length,
      expectedCurrentPublicationId: null,
      rollbackOfPublicationId: null,
      reason: "synthetic aggregate verification",
    });
    const planHash = sha(planText);
    // A deliberately synthetic authenticated HTTP facade. It admits only this
    // fixture token, then executes actual actor-only SQL under its fixed identity.
    // This proves transport/wire/SQL interoperability, not hosted JWT verification.
    const token = [
      "header",
      Buffer.from(
        JSON.stringify({
          sub: actorId,
          role: "authenticated",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url"),
      "synthetic-signature",
    ].join(".");
    const pool = new pg.Pool({ connectionString, max: 2 });
    t.after(() => pool.end());
    const server = createServer(async (req, res) => {
      let client;
      try {
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        assert.equal(req.headers["content-profile"], "api");
        assert.equal(req.headers.apikey, "sb_publishable_synthetic");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const b = JSON.parse(Buffer.concat(chunks));
        const routines = {
          qry_final_result_query_v2: [
            "p_result_id",
            "p_result_version",
            "p_publication_id",
          ],
          qry_source_final_results_v2: [
            "p_source_id",
            "p_source_version",
            "p_after_key",
            "p_limit",
            "p_publication_id",
          ],
          qry_final_result_download_v2: ["p_publication_id", "p_format"],
          qry_final_result_release_probe_page_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
            "p_runtime_revision",
            "p_after_artifact_id",
            "p_limit",
          ],
          qry_final_result_release_probe_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
            "p_runtime_revision",
            "p_result_id",
            "p_result_version",
          ],
          qry_final_result_publication_head_v2: [],
          qry_final_result_release_v2: ["p_release_run_id"],
          qry_final_result_release_approval_v2: [
            "p_release_run_id",
            "p_approval_id",
          ],
          cmd_final_result_release_prepare_v2: [
            "p_plan_text",
            "p_idempotency_key",
          ],
          cmd_final_result_release_members_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
            "p_rows",
          ],
          cmd_final_result_release_seal_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
          ],
          cmd_final_result_release_approve_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
            "p_verification_id",
            "p_approval_id",
            "p_expected_approval_id",
            "p_expires_at",
            "p_reason",
          ],
          cmd_final_result_release_activate_v2: [
            "p_release_run_id",
            "p_publish_plan_hash",
            "p_approval_id",
            "p_approval_hash",
            "p_verification_id",
            "p_idempotency_key",
            "p_credential_fingerprint",
          ],
        };
        const routine = req.url.replace("/rest/v1/rpc/", "");
        assert.ok(Object.hasOwn(routines, routine));
        const fields = routines[routine];
        assert.deepEqual(Object.keys(b).sort(), [...fields].sort());
        client = await pool.connect();
        await client.query(
          routine.startsWith("qry_")
            ? "begin read only;set local role authenticated"
            : "begin;set local role authenticated",
        );
        await client.query(
          "select set_config('request.jwt.claim.sub',$1,true)",
          [actorId],
        );
        const reply = await client.query(
          `select api.${routine}(${fields.map((_, i) => `$${i + 1}`).join(",")}) r`,
          fields.map((k) => (k === "p_rows" ? JSON.stringify(b[k]) : b[k])),
        );
        await client.query("commit");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.rows[0].r));
      } catch {
        if (client) await client.query("rollback").catch(() => {});
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"ok":false,"code":"synthetic_failure"}');
      } finally {
        client?.release();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const actor = createFinalResultActor({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      publishableKey: "sb_publishable_synthetic",
      accessToken: token,
    });
    const publication = createFinalResultPublication({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      publishableKey: "sb_publishable_synthetic",
      accessToken: token,
    });
    assert.equal(await publication.head(), null);
    assert.equal(await publication.run(runId), null);
    assert.equal(
      await publication.approval({ releaseRunId: runId, approvalId: id(405) }),
      null,
    );
    await publication.prepare({
      planText,
      idempotencyKey: "synthetic-aggregate",
    });
    await publication.members({
      releaseRunId: runId,
      publishPlanHash: planHash,
      rows: members,
    });
    await publication.seal({ releaseRunId: runId, publishPlanHash: planHash });
    assert.equal((await publication.run(runId)).selectionSealed, true);
    const events = [];
    const lost = new Set();
    const uncertain = { ...registry };
    for (const method of ["beginReadiness", "stageReadiness", "sealReadiness"])
      uncertain[method] = async (...args) => {
        const result = await registry[method](...args);
        if (!lost.has(method)) {
          lost.add(method);
          throw Object.assign(
            new Error("synthetic lost ACK after SQL commit"),
            { code: "final_storage_registry_outcome_unknown" },
          );
        }
        return result;
      };
    const receipt = await verifyFinalResultReadiness({
      candidateDir: f.candidateDir,
      inputDir: f.input.outDir,
      releaseRunId: runId,
      publishPlanHash: planHash,
      verificationId,
      objectStore: storage.store,
      registry: uncertain,
      actor,
      reader: runtime.reader,
      record: async (e) => events.push(structuredClone(e)),
    });
    assert.equal(receipt.artifactCount, 2);
    assert.equal(receipt.probeCount, 3);
    assert.equal(receipt.fileCount, 14);
    assert.equal(receipt.publicationAuthorized, false);
    assert.deepEqual(
      (await registry.describeReadiness(verificationId)).readinessReceipt,
      receipt,
    );
    assert.equal(
      (
        await owner.query(
          "select status from private.lca_release_runs where id=$1",
          [runId],
        )
      ).rows[0].status,
      "prepared",
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
          "select count(*)::int n from private.lca_release_publications",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(events.at(-1).kind, "sealed");
    // Run the public command as a separate process with actual adapters and
    // private, flushed evidence. This is a new verification, never a replay.
    const { stdout: cliOut, stderr: cliErr } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../cli.mjs", import.meta.url)),
        "result-readiness",
        "verify",
        "--candidate",
        f.candidateDir,
        "--final-input",
        f.input.outDir,
        "--run-id",
        runId,
        "--publish-plan-hash",
        planHash,
        "--out-dir",
        path.join(f.input.root, "cli-readiness"),
        "--json",
      ],
      {
        env: {
          PATH: process.env.PATH,
          CONN: connectionString,
          S3_ENDPOINT: storage.endpoint,
          S3_REGION: "us-east-1",
          S3_BUCKET: "synthetic-results",
          S3_PREFIX: "test-owned",
          S3_ACCESS_KEY_ID: "synthetic-access",
          S3_SECRET_ACCESS_KEY: "synthetic-secret",
          TIANGONG_LCA_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
          TIANGONG_LCA_ACCESS_TOKEN: token,
          RESULT_QUERY_ENDPOINT: runtime.endpoint,
          RESULT_QUERY_SERVICE_SECRET: runtime.secret,
        },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(cliErr, "");
    const cliResult = JSON.parse(cliOut);
    assert.equal(cliResult.ok, true);
    assert.equal(cliResult.publicationAuthorized, false);
    assert.equal(cliResult.artifactCount, 2);
    assert.equal(cliResult.probeCount, 3);
    assert.equal(cliResult.fileCount, 14);
    assert.notEqual(cliResult.verificationId, verificationId);
    const diskReceipt = JSON.parse(
      await readFile(cliResult.artifacts.readinessReceipt),
    );
    assert.deepEqual(
      (await registry.describeReadiness(cliResult.verificationId))
        .readinessReceipt,
      diskReceipt,
    );
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
    const managerEnv = {
      PATH: process.env.PATH,
      TIANGONG_LCA_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
      TIANGONG_LCA_ACCESS_TOKEN: token,
    };
    const managerCommand = async (action, args) => {
      const reply = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL("../cli.mjs", import.meta.url)),
          "result-publication",
          action,
          ...args,
          "--json",
        ],
        { env: managerEnv, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(reply.stderr, "");
      return JSON.parse(reply.stdout);
    };
    // A separate explicitly synthetic authority exercise. This is the only
    // phase here that approves/activates; readiness above performs neither.
    const builtPlan = await buildFinalResultPublicationPlan({
      candidateDir: f.candidateDir,
      targetHash: storage.store.targetHash,
      actor: publication,
      releaseRunId: id(410),
      releaseVersion: "2026.11.1",
      reason: "synthetic selection command",
    });
    const planEvents = [];
    const prepared = await prepareFinalResultPublication({
      local: builtPlan.local,
      confirmLocalPlanHash: builtPlan.localPlanHash,
      actor: publication,
      record: async (e) => planEvents.push(e),
    });
    assert.equal(prepared.selectionHash, selectionHash);
    assert.equal(prepared.selectionCount, 3);
    assert.equal((await publication.run(id(410))).selectionSealed, true);
    const approvalArgs = {
      releaseRunId: runId,
      publishPlanHash: planHash,
      verificationId: cliResult.verificationId,
      approvalId: id(405),
      expectedApprovalId: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reason: "explicit synthetic integration approval",
    };
    const authorityPlanDir = path.join(f.input.root, "authority-plan"),
      approvalDir = path.join(f.input.root, "approval-intent"),
      activationDir = path.join(f.input.root, "activation-intent");
    await mkdir(authorityPlanDir);
    await writeFile(
      path.join(authorityPlanDir, "publication-plan.json"),
      canonicalJson({
        schemaVersion: "tiangong.final-result-publication-local-plan.v1",
        actorId,
        apiTargetHash: publication.apiTargetHash,
        candidateDir: f.candidateDir,
        planText,
        publishPlanHash: planHash,
        members,
        publicationAuthorized: false,
      }),
    );
    const approvalPlanned = await managerCommand("approval-plan", [
      "--plan-dir",
      authorityPlanDir,
      "--readiness-receipt",
      cliResult.artifacts.readinessReceipt,
      "--approval-id",
      id(405),
      "--expires-at",
      approvalArgs.expiresAt,
      "--reason",
      approvalArgs.reason,
      "--out-dir",
      approvalDir,
    ]);
    const approvalObserved = await managerCommand("approve", [
      "--plan-dir",
      authorityPlanDir,
      "--intent-dir",
      approvalDir,
      "--confirm",
      approvalPlanned.intentHash,
      "--out-dir",
      path.join(f.input.root, "approval-execution"),
    ]);
    const observedApproval = await publication.approval({
      releaseRunId: runId,
      approvalId: id(405),
    });
    assert.equal(approvalObserved.status, "approved");
    assert.equal(observedApproval.status, "approved");
    const activationPlanned = await managerCommand("activation-plan", [
      "--plan-dir",
      authorityPlanDir,
      "--readiness-receipt",
      cliResult.artifacts.readinessReceipt,
      "--approval-id",
      id(405),
      "--out-dir",
      activationDir,
    ]);
    const activationIntent = JSON.parse(
      await readFile(activationPlanned.artifacts.intent),
    );
    const activationArgs = {
      releaseRunId: runId,
      publishPlanHash: planHash,
      approvalId: id(405),
      approvalHash: observedApproval.approvalHash,
      verificationId: cliResult.verificationId,
      idempotencyKey: activationIntent.idempotencyKey,
      credentialFingerprint: activationIntent.credentialFingerprint,
    };
    const activated = await managerCommand("activate", [
      "--plan-dir",
      authorityPlanDir,
      "--intent-dir",
      activationDir,
      "--confirm",
      activationPlanned.intentHash,
      "--out-dir",
      path.join(f.input.root, "activation-execution"),
    ]);
    assert.equal(activated.publicReadbackVerified, false);
    const current = await publication.head(),
      observedRun = await publication.run(runId);
    assert.equal(current.publicationId, activated.publicationId);
    assert.equal(current.format, "final-result-pair.v2");
    assert.equal(
      observedRun.publication.publicationId,
      activated.publicationId,
    );
    assert.equal(observedRun.activeApproval, null);
    assert.equal(observedRun.publication.isCurrent, true);
    assert.equal(
      observedRun.publication.verificationId,
      cliResult.verificationId,
    );
    assert.equal(
      (await publication.approval({ releaseRunId: runId, approvalId: id(405) }))
        .status,
      "consumed",
    );
    assert.equal((await publication.approve(approvalArgs)).status, "consumed");
    assert.equal((await publication.activate(activationArgs)).reused, true);
    const oldApproval = await managerCommand("approve", [
      "--plan-dir",
      authorityPlanDir,
      "--intent-dir",
      approvalDir,
      "--confirm",
      approvalPlanned.intentHash,
      "--out-dir",
      path.join(f.input.root, "approval-recovery"),
    ]);
    assert.equal(oldApproval.status, "consumed");
    const recovered = await managerCommand("activate", [
      "--plan-dir",
      authorityPlanDir,
      "--intent-dir",
      activationDir,
      "--confirm",
      activationPlanned.intentHash,
      "--out-dir",
      path.join(f.input.root, "activation-recovery"),
    ]);
    assert.equal(recovered.publicationId, activated.publicationId);

    // Optional exact Edge checkout executes its real handler, SDK actor transport
    // and Worker v2 wire against the above SQL facade. Fixed synthetic auth only.
    if (process.env.RELEASE_QUERY_EDGE_ROOT) {
      const edgeRoot = path.resolve(process.env.RELEASE_QUERY_EDGE_ROOT);
      const edgeInput = path.join(f.input.root, "synthetic-edge-input.json");
      const runEdge = async (requests) => {
        await writeFile(
          edgeInput,
          JSON.stringify({
            actorEndpoint: `http://127.0.0.1:${server.address().port}`,
            actorId,
            token,
            readerEndpoint: runtime.endpoint,
            readerSecret: runtime.secret,
            requests,
          }),
          { mode: 0o600 },
        );
        const { stdout } = await promisify(execFile)(
          process.env.RELEASE_QUERY_DENO_BIN || "deno",
          [
            "run",
            "--config",
            path.join(edgeRoot, "supabase/functions/deno.json"),
            "--allow-env",
            "--allow-read",
            "--allow-net=127.0.0.1",
            path.join(edgeRoot, "test/fixtures/final-result-gateway.ts"),
            edgeInput,
          ],
          {
            cwd: edgeRoot,
            env: { PATH: process.env.PATH },
            timeout: 60000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        return JSON.parse(stdout);
      };
      const query = (row, kind, extra = {}) => ({
        mode: "final_query",
        resultId: row.uuid,
        resultVersion: row.version,
        publicationId: activated.publicationId,
        runtimeRevision: revision,
        query: { kind, ...(kind === "lci" ? { limit: 1 } : {}), ...extra },
      });
      const rows = f.loaded.queryCatalog.results;
      const requests = rows.flatMap((row) => [
        query(row, "overview"),
        query(row, "lci"),
        query(row, "lcia"),
      ]);
      const replies = await runEdge(requests);
      const amounts = [],
        impacts = [],
        continuations = [];
      for (const [i, row] of rows.entries()) {
        const [overview, lci, lcia] = replies.slice(i * 3, i * 3 + 3);
        assert.equal(overview.status, 200);
        assert.equal(overview.body.data.result.uuid, row.uuid);
        assert.equal(
          overview.body.data.data.result.relationKind,
          row.relationKind,
        );
        assert.equal(overview.body.data.runtimeRevision, revision);
        assert.equal(lci.status, 200);
        amounts.push(...lci.body.data.data.items.map((item) => item.amount));
        if (lci.body.data.data.nextCursor)
          continuations.push(
            query(row, "lci", { cursor: lci.body.data.data.nextCursor }),
          );
        if (row.layer === "lci-lcia") {
          assert.equal(lcia.status, 200);
          impacts.push(
            ...lcia.body.data.data.impacts.map((item) => item.amount),
          );
        } else {
          assert.equal(lcia.status, 404);
          assert.equal(lcia.body.code, "RESULT_LCIA_NOT_AVAILABLE");
        }
      }
      for (const reply of await runEdge(continuations)) {
        assert.equal(reply.status, 200);
        amounts.push(...reply.body.data.data.items.map((item) => item.amount));
        assert.equal(reply.body.data.data.nextCursor, null);
      }
      assert.deepEqual(
        amounts.sort((a, b) => a - b),
        [-3, 2.5, 4.25],
      );
      assert.deepEqual(
        impacts.sort((a, b) => a - b),
        [0, 42],
      );
      const denied = await runEdge([
        { ...query(rows[0], "overview"), runtimeRevision: id(499) },
        {
          mode: "source_results",
          sourceId: id(999),
          sourceVersion: "01.00.000",
        },
        {
          mode: "final_download",
          publicationId: activated.publicationId,
          format: "tidas",
        },
      ]);
      assert.deepEqual(
        denied.map((r) => r.status),
        [409, 404, 404],
      );
      assert.equal(denied[1].body.code, "SOURCE_NOT_AVAILABLE");
      assert.equal(denied[2].body.code, "RESULT_PACKAGE_NOT_AVAILABLE");
      t.diagnostic(
        "Actual Edge v2: three Result overviews, complete paged LCI [-3,2.5,4.25], LCIA [0,42], absent LCIA, reader pin and actor RLS denials passed",
      );
    }

    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.lca_release_publications",
        )
      ).rows[0].n,
      1,
    );

    const planDir = path.join(f.input.root, "cli-publication-plan"),
      prepareDir = path.join(f.input.root, "cli-publication-prepare");
    const planned = await managerCommand("plan", [
      "--candidate",
      f.candidateDir,
      "--target-hash",
      storage.store.targetHash,
      "--run-id",
      id(411),
      "--release-version",
      "2026.11.2",
      "--reason",
      "synthetic actor CLI selection",
      "--out-dir",
      planDir,
    ]);
    assert.equal(planned.expectedCurrentPublicationId, activated.publicationId);
    assert.equal(planned.selectionCount, 3);
    const selected = await managerCommand("prepare", [
      "--plan-dir",
      planDir,
      "--confirm",
      planned.localPlanHash,
      "--out-dir",
      prepareDir,
    ]);
    assert.equal(selected.publicationAuthorized, false);
    assert.equal(selected.selectionCount, 3);
    const status = await managerCommand("status", [
      "--run-id",
      id(411),
      "--out-dir",
      path.join(f.input.root, "cli-publication-status"),
    ]);
    assert.equal(status.selectionSealed, true);
    assert.equal(status.status, "prepared");
    assert.equal(status.currentPublicationId, null);
    const observation = JSON.parse(
      await readFile(status.artifacts.observation),
    );
    assert.equal(observation.snapshot.publishPlanHash, planned.publishPlanHash);
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.lca_release_publications",
        )
      ).rows[0].n,
      1,
    );
  },
);
