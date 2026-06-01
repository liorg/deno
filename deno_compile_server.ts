// deno_compile_server.ts
// Deno server — מקבל קוד TypeScript, בודק תקינות ומחזיר תוצאה
// הרצה: deno run --allow-net --allow-read --allow-write --allow-env deno_compile_server.ts

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const PORT = parseInt(Deno.env.get("DENO_PORT") || "8765");

// ── Sample payload for test run ──────────────────────────────────────────────
const SAMPLE_PAYLOAD = {
  scenarioId: "test-scenario-123",
  stepId: "n_0001",
  target_contact: { id: "contact-abc", phone: "972501234567", name: "Test User" },
  source_phone: { id: "phone-xyz", phone: "972500000000" },
  lastMessage: { num: "n_0000", Value: "Hello" },
};

interface CheckRequest {
  code: string;
  card_type: "sender" | "expect";
}

interface CheckResponse {
  ok: boolean;
  errors: string[];
  output: unknown | null;
  type_errors: string[];
}

// ── Type declaration injected before user code ───────────────────────────────
const PAYLOAD_TYPE_DECL = `
interface __Payload {
  scenarioId: string;
  stepId: string;
  target_contact: { id: string; phone: string; name: string; };
  source_phone: { id: string; phone: string; };
  lastMessage: { num: string; Value: string; };
}
`;

// ── Wrap user code for execution ─────────────────────────────────────────────
function wrapCode(code: string): string {
  // מסיר export default ומעטפת לריצה מבוקרת
  const cleaned = code
    .replace(/^export\s+default\s+/m, "const __userFn = ")
    .replace(/^module\.exports\s*=\s*/m, "const __userFn = ");

  return `
// deno-lint-ignore-file
// @ts-nocheck for implicit any on payload param
${PAYLOAD_TYPE_DECL}
${cleaned}

// Run with sample payload
const __payload: __Payload = ${JSON.stringify(SAMPLE_PAYLOAD)};
let __result;
try {
  if (typeof __userFn === "function") {
    __result = await __userFn(__payload);
  } else {
    throw new Error("export default חייב להיות פונקציה");
  }
} catch(e) {
  throw e;
}
console.log(JSON.stringify({ __scenariobot_result: __result }));
`;
}

// ── Validate result shape ────────────────────────────────────────────────────
function validateResult(result: unknown): string[] {
  const errors: string[] = [];
  if (!result || typeof result !== "object") {
    errors.push("הפונקציה חייבת להחזיר אובייקט");
    return errors;
  }
  const r = result as Record<string, unknown>;
  if (typeof r.success !== "boolean") {
    errors.push("חסר שדה 'success' מסוג boolean");
  }
  return errors;
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handler(req: Request): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, errors: ["Method not allowed"] }), { status: 405, headers });
  }

  let body: CheckRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, errors: ["Invalid JSON body"] }), { status: 400, headers });
  }

  const { code, card_type } = body;
  if (!code || typeof code !== "string") {
    return new Response(JSON.stringify({ ok: false, errors: ["Missing 'code' field"] }), { status: 400, headers });
  }

  const result: CheckResponse = { ok: false, errors: [], output: null, type_errors: [] };

  try {
    // ── Write temp file ─────────────────────────────────────────────────────
    const tmpFile = await Deno.makeTempFile({ prefix: "scenariobot_", suffix: ".ts" });
    const wrapped = wrapCode(code);
    await Deno.writeTextFile(tmpFile, wrapped);

    // ── Step 1: Type-check with deno check ──────────────────────────────────
    const checkCmd = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const checkProc = await checkCmd.output();
    const checkStderr = new TextDecoder().decode(checkProc.stderr);

    if (!checkProc.success) {
      // Parse type errors
      const typeErrors = checkStderr
        .split("\n")
        .filter(l => l.includes("error[") || l.includes("TS") || (l.trim().startsWith("×") || l.trim().startsWith("error")))
        .map(l => l.trim())
        .filter(Boolean)
        .slice(0, 10); // max 10 errors

      result.type_errors = typeErrors;
      result.errors = typeErrors.length > 0 ? typeErrors : [checkStderr.slice(0, 500)];

      await Deno.remove(tmpFile).catch(() => {});
      return new Response(JSON.stringify(result), { headers });
    }

    // ── Step 2: Run to validate runtime behavior ────────────────────────────
    const runCmd = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--no-prompt", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });

    // Timeout: 5 seconds
    const runProc = await Promise.race([
      runCmd.output(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]);

    await Deno.remove(tmpFile).catch(() => {});

    if (!runProc) {
      result.errors = ["timeout: הקוד רץ יותר מ-5 שניות"];
      return new Response(JSON.stringify(result), { headers });
    }

    const stdout = new TextDecoder().decode(runProc.stdout);
    const stderr = new TextDecoder().decode(runProc.stderr);

    if (!runProc.success) {
      const runtimeErrors = stderr
        .split("\n")
        .filter(l => l.includes("error") || l.includes("Error") || l.includes("throw"))
        .map(l => l.trim())
        .filter(Boolean)
        .slice(0, 5);
      result.errors = runtimeErrors.length > 0 ? runtimeErrors : [stderr.slice(0, 300)];
      return new Response(JSON.stringify(result), { headers });
    }

    // ── Parse output ─────────────────────────────────────────────────────────
    const outputLine = stdout.split("\n").find(l => l.includes("__scenariobot_result"));
    if (outputLine) {
      try {
        const parsed = JSON.parse(outputLine);
        const fnResult = parsed.__scenariobot_result;
        const shapeErrors = validateResult(fnResult);
        if (shapeErrors.length > 0) {
          result.errors = shapeErrors;
          return new Response(JSON.stringify(result), { headers });
        }
        result.ok = true;
        result.output = fnResult;
      } catch {
        result.errors = ["לא ניתן לפענח את פלט הפונקציה"];
      }
    } else {
      result.errors = ["הפונקציה לא החזירה פלט תקין (חסר console.log)"];
    }

  } catch (e) {
    result.errors = [e instanceof Error ? e.message : String(e)];
  }

  return new Response(JSON.stringify(result), { headers });
}

console.log(`🦕 Deno compile server running on :${PORT}`);
await serve(handler, { port: PORT });
