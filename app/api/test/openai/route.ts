import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getActorContext } from "@/lib/server/getActorContext";

export const runtime = "nodejs";

function getKeyDiagnostics(key: string) {
  return {
    startsWithSk: key.startsWith("sk-"),
    containsEllipsis: key.includes("..."),
    containsWhitespace: /\s/.test(key),
    length: key.length,
    prefix: key.slice(0, 7),
    suffix: key.slice(-4),
  };
}

export async function GET(req: Request) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const key = process.env.OPENAI_API_KEY;

  // Stage 1: env check
  if (!key) {
    return NextResponse.json(
      { ok: false, stage: "env", error: "OPENAI_API_KEY not set" },
      { status: 500 }
    );
  }

  const diagnostics = getKeyDiagnostics(key);

  console.log("OpenAI test — key diagnostics (safe):", {
    length: diagnostics.length,
    startsWithSk: diagnostics.startsWithSk,
    containsEllipsis: diagnostics.containsEllipsis,
    containsWhitespace: diagnostics.containsWhitespace,
  });

  // Stage 2: format validation
  const isMalformed =
    diagnostics.containsEllipsis ||
    diagnostics.containsWhitespace ||
    !diagnostics.startsWithSk ||
    diagnostics.length < 40;

  if (isMalformed) {
    return NextResponse.json(
      {
        ok: false,
        stage: "validation",
        error: "OPENAI_API_KEY appears malformed",
        diagnostics,
      },
      { status: 500 }
    );
  }

  // Stage 3: live API call
  try {
    const client = new OpenAI({ apiKey: key });
    const model = "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: success" }],
      max_tokens: 10,
    });

    const text = completion.choices[0]?.message?.content?.trim() ?? "";

    console.log("OpenAI test — success:", text);

    return NextResponse.json({
      ok: true,
      stage: "complete",
      model,
      response: text || "success",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OpenAI test route error:", err);

    return NextResponse.json(
      {
        ok: false,
        stage: "request",
        error: message,
        diagnostics,
      },
      { status: 500 }
    );
  }
}
