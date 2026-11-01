import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidate, worker, id } from "./fixtures/final-reader.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
import { createFinalResultIdentityStore } from "../../release-candidate/lib/final-result-identity.mjs";
import { createFinalResultRegistry } from "../adapters/final-result-registry.mjs";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
import {
  inspectFinalResultStorage,
  executeFinalResultStorage,
} from "../lib/final-result-storage.mjs";
import { verifyFinalResultReadiness } from "../lib/final-result-readiness.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");

test(
  "actual registered Candidate and Worker evidence seals in isolated PostgreSQL without approval",
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
    const planText = JSON.stringify({
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
    await owner.query("begin;set local role authenticated");
    await owner.query("select set_config('request.jwt.claim.sub',$1,true)", [
      actorId,
    ]);
    for (const [sql, args] of [
      [
        "select api.cmd_final_result_release_prepare_v2($1,'synthetic-aggregate') r",
        [planText],
      ],
      [
        "select api.cmd_final_result_release_members_v2($1,$2,$3) r",
        [runId, planHash, JSON.stringify(members)],
      ],
      [
        "select api.cmd_final_result_release_seal_v2($1,$2) r",
        [runId, planHash],
      ],
    ])
      assert.equal((await owner.query(sql, args)).rows[0].r.ok, true);
    await owner.query("commit");
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
        const page =
          req.url === "/rest/v1/rpc/qry_final_result_release_probe_page_v2";
        assert.ok(
          page || req.url === "/rest/v1/rpc/qry_final_result_release_probe_v2",
        );
        client = await pool.connect();
        await client.query("begin read only;set local role authenticated");
        await client.query(
          "select set_config('request.jwt.claim.sub',$1,true)",
          [actorId],
        );
        const reply = await client.query(
          page
            ? "select api.qry_final_result_release_probe_page_v2($1,$2,$3,$4,$5) r"
            : "select api.qry_final_result_release_probe_v2($1,$2,$3,$4,$5) r",
          page
            ? [
                b.p_release_run_id,
                b.p_publish_plan_hash,
                b.p_runtime_revision,
                b.p_after_artifact_id,
                b.p_limit,
              ]
            : [
                b.p_release_run_id,
                b.p_publish_plan_hash,
                b.p_runtime_revision,
                b.p_result_id,
                b.p_result_version,
              ],
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
  },
);
