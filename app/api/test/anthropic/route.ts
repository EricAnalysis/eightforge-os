import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

function getKeyDiagnostics(key: string) {
  return {
    startsWithSkAnt: key.startsWith("sk-ant-"),
    containsEllipsis: key.includes("..."),
    containsWhitespace: /\s/.test(key),
    length: key.length,
    prefix: key.slice(0, 10),
    suffix: key.slice(-4),
  };
}

export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY;

  // Stage 1: env check
  if (!key) {
    return NextResponse.json(
      { ok: false, stage: "env", error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const diagnostics = getKeyDiagnostics(key);
  console.log("Anthropic test — key diagnostics (safe):", {
    ...diagnostics,
    // never log prefix/suffix here; only log shape
    length: diagnostics.length,
    startsWithSkAnt: diagnostics.startsWithSkAnt,
    containsEllipsis: diagnostics.containsEllipsis,
    containsWhitespace: diagnostics.containsWhitespace,
  });

  // Stage 2: format validation
  const isMalformed =
    diagnostics.containsEllipsis ||
    diagnostics.containsWhitespace ||
    !diagnostics.startsWithSkAnt ||
    diagnostics.length < 40;

  if (isMalformed) {
    return NextResponse.json(
      {
        ok: false,
        stage: "validation",
        error: "ANTHROPIC_API_KEY appears malformed",
        diagnostics,
      },
      { status: 500 }
    );
  }

  // Stage 3: live API call
  try {
    const client = new Anthropic({ apiKey: key });
    const model = "claude-3-5-haiku-20241022";

    const message = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the word OK only." }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";
    console.log("Anthropic test — success:", text);

    return NextResponse.json({ ok: true, stage: "complete", model, response: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Anthropic test route error:", err);

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
