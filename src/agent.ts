// Claude calls, through the Claude Agent SDK driving the local `claude` CLI.
// Each call is a short Claude Code session: no user/project settings, nothing
// saved to session history, and only the tools that step needs.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  claudePath: string;
}

/** Per-call choice from the model / thinking pickers. */
export interface ModelChoice {
  model: string; // "" → Claude Code's default
  effort: Effort;
}

/** A passage the learner quoted from the note: rendered text plus a little context. */
export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  quotes?: Quote[];
}

export class AgentError extends Error {}

interface RunOptions extends ModelChoice {
  system: string;
  prompt: string;
  tools?: string[];
  mcpServers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
  maxTurns?: number;
  cwd?: string;
}

const NOT_LOGGED_IN = "Claude Code 还没登录：在终端运行 `claude auth login`（Pro/Max 账号），然后重试。";

export function findClaude(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".claude/local/claude"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "";
}

async function runAgent(cfg: AgentConfig, opts: RunOptions): Promise<string> {
  if (!cfg.claudePath || !fs.existsSync(cfg.claudePath)) {
    throw new AgentError("找不到 claude 命令行。请在插件设置里填写它的路径（终端运行 `which claude` 可以查到）。");
  }
  const { system, prompt, model, effort, tools = [], mcpServers, maxTurns = 1, cwd = scratchDir() } = opts;
  let result: any;
  try {
    for await (const m of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cfg.claudePath,
        systemPrompt: system,
        tools,
        allowedTools: [...tools, ...Object.keys(mcpServers ?? {}).map((name) => `mcp__${name}__*`)],
        ...(mcpServers ? { mcpServers } : {}),
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        maxTurns,
        effort,
        cwd,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "obsidian-study-agent/0.1.0" },
        ...(model ? { model } : {}),
      },
    })) {
      if (m.type === "result") result = m;
    }
  } catch (err) {
    if (!result) throw friendly((err as Error).message);
  }
  if (!result) throw new AgentError("Agent 没有返回结果。");
  if (result.is_error || result.subtype !== "success") {
    throw friendly(result.result || result.errors?.join("; ") || result.subtype);
  }
  return String(result.result).trim();
}

function friendly(message = ""): AgentError {
  if (/not logged in|\/login|invalid api key|authentication/i.test(message)) return new AgentError(NOT_LOGGED_IN);
  const outdated = message.match(/Claude Code ([\d.]+) does not support this model; version ([\d.]+)/i);
  if (outdated) {
    return new AgentError(
      `本机的 claude 命令行版本太旧（${outdated[1]}），这个模型需要 ${outdated[2]} 或更新。在终端运行 \`claude update\` 后重试，或者先换一个模型。`,
    );
  }
  if (/rate.?limit|usage limit|limit reached/i.test(message)) return new AgentError(`用量达到上限：${message}`);
  if (/max.?turns/i.test(message)) return new AgentError("Agent 轮次用完了还没做完，试着把要求拆小一点。");
  return new AgentError(`Agent 出错：${message}`);
}

function scratchDir(): string {
  const dir = path.join(os.tmpdir(), "obsidian-study-agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const transcript = (messages: ChatMessage[]) =>
  messages.map((m) => `${m.role === "user" ? "Learner" : "You"}: ${withQuotes(m.text, m.quotes)}`).join("\n\n");

/** A message with the passages it quotes, so "this" / "这段" can be resolved. */
function withQuotes(text: string, quotes: Quote[] = []): string {
  if (!quotes.length) return text;
  const passages = quotes
    .map((q) => `<passage>\n<before>${q.prefix}</before>\n<quoted>${q.exact}</quoted>\n<after>${q.suffix}</after>\n</passage>`)
    .join("\n");
  return `<quoted_passages>\n${passages}\n</quoted_passages>\n\n${text}`;
}

// ---------- guide generation ----------

const GUIDE_SYSTEM = `You write study guides as Obsidian notes.

Your final reply must be ONLY the Markdown of the note — no code fence around it, no YAML frontmatter, nothing before the title.

Structure it for learning, not as a summary:
- Start with "# <title>", then "## 学习目标" (learning objectives) as a short list.
- Sections with ## / ###, built from intuition first, then precise definitions, then worked examples.
- Obsidian callouts: "> [!tip] 关键点" for key insights, "> [!warning] 常见误区" for common mistakes, and foldable self-checks as "> [!question]- <question>" with the answer inside the callout.
- Tables, code blocks and lists where they help.
- Math: inline $...$, display $$...$$ on their own lines.
- End with "## 小结" (recap) and "## 练习" (a few practice questions).

Write in the language the user writes in (default 简体中文), keeping standard technical terms in English where that is how they are usually written.`;

export interface GuideSource {
  request: string;
  material?: { name: string; text?: string; pdf?: ArrayBuffer };
}

export async function generateGuide(cfg: AgentConfig, choice: ModelChoice, src: GuideSource): Promise<string> {
  const tools: string[] = [];
  let cwd: string | undefined;
  let attachment = "";

  if (src.material?.pdf) {
    // Claude Code reads PDFs with its Read tool, so stage the file in a temp dir.
    cwd = fs.mkdtempSync(path.join(scratchDir(), "src-"));
    fs.writeFileSync(path.join(cwd, "source.pdf"), Buffer.from(src.material.pdf));
    tools.push("Read");
    attachment = `The material is the PDF at ./source.pdf (originally "${src.material.name}") — read all of it with the Read tool first.\n\n`;
  } else if (src.material?.text) {
    attachment = `<material name="${src.material.name}">\n${src.material.text}\n</material>\n\n`;
  }
  if (/https?:\/\//.test(src.request)) tools.push("WebFetch");

  const request = src.request.trim()
    ? `Create a study guide from this material / request:\n\n${src.request}`
    : "Create a study guide from the material above.";

  try {
    const text = await runAgent(cfg, { ...choice, system: GUIDE_SYSTEM, prompt: attachment + request, tools, maxTurns: 12, cwd });
    return text.replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim() + "\n";
  } finally {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------- main agent (edits the note) ----------

const EDITOR_SYSTEM = `You are the editor of a study note the learner is reading in Obsidian. The note's current Markdown is in <note>.

When the learner asks for a change, make it with the tools:
- edit_note: replace one exact snippet of the current Markdown. Prefer this for local changes; call it several times for several changes.
- rewrite_note: replace the whole note. Use only for restructuring that touches most of it.

Keep the note's conventions (Obsidian callouts, $ / $$ math, headings). Keep any YAML frontmatter as it is.
The learner has questions anchored to exact passages of the note (listed in <threads>). Keep the wording of passages you are not asked to change, so those anchors survive. When the learner asks you to fold their questions into the note, use those threads.

The learner may quote passages of the note (in <quoted_passages>, with a little text before and after each). When they say "this" / "这段" / "这里", they mean those passages. Quotes are the text as rendered, without Markdown syntax (no **, $, [[ ]], callout markers), so match them against the Markdown loosely and copy the real Markdown into edit_note.

If the learner only asks a question, answer it without editing. After editing, reply with one or two sentences saying what you changed. Reply in the learner's language.`;

export interface NoteOps {
  edit(oldStr: string, newStr: string): Promise<string | null>; // error message or null
  rewrite(content: string): Promise<void>;
}

export async function editorTurn(
  cfg: AgentConfig,
  choice: ModelChoice,
  args: { note: string; history: ChatMessage[]; threads: string; message: string; quotes?: Quote[]; ops: NoteOps },
): Promise<{ reply: string; edits: number }> {
  let edits = 0;
  const result = (error: string | null, ok: string) => {
    if (!error) edits++;
    return { content: [{ type: "text" as const, text: error ?? ok }], ...(error ? { isError: true } : {}) };
  };
  const server = createSdkMcpServer({
    name: "note",
    version: "1.0.0",
    tools: [
      tool(
        "edit_note",
        "Replace one exact snippet of the current note Markdown. old_str must appear exactly once (copy it character for character); new_str replaces it.",
        { old_str: z.string().describe("Exact Markdown currently in the note, unique."), new_str: z.string().describe("Replacement Markdown.") },
        async ({ old_str, new_str }) => result(await args.ops.edit(old_str, new_str), "Edit applied."),
      ),
      tool(
        "rewrite_note",
        "Replace the entire note with new Markdown.",
        { content: z.string().describe("The full new note Markdown.") },
        async ({ content }) => {
          await args.ops.rewrite(content);
          return result(null, "Note replaced.");
        },
      ),
    ],
  });

  const prompt = [
    args.history.length ? `<earlier_conversation>\n${transcript(args.history)}\n</earlier_conversation>` : "",
    `<note>\n${args.note}\n</note>`,
    `<threads>\n${args.threads || "(none)"}\n</threads>`,
    withQuotes(args.message, args.quotes),
  ]
    .filter(Boolean)
    .join("\n\n");

  const reply = await runAgent(cfg, { ...choice, system: EDITOR_SYSTEM, prompt, mcpServers: { note: server }, maxTurns: 20 });
  return { reply: reply || "（已完成）", edits };
}

// ---------- side chat (question about a highlighted passage) ----------

const SIDE_SYSTEM = `You are a tutor answering questions about one passage the learner highlighted in their study note. The full note is in <note> for context and the highlighted passage is in <highlight>.

Answer the latest question about the highlight directly and briefly (usually under 150 words): explain, give an intuition or a tiny example, and point out a common confusion if relevant. Use Markdown; math with $...$ and $$...$$. Reply in the learner's language.`;

export async function sideChatReply(
  cfg: AgentConfig,
  choice: ModelChoice,
  args: { note: string; quote: string; history: ChatMessage[]; question: string },
): Promise<string> {
  const prompt = [
    `<note>\n${args.note}\n</note>`,
    `<highlight>${args.quote}</highlight>`,
    args.history.length ? `<earlier_questions>\n${transcript(args.history)}\n</earlier_questions>` : "",
    args.question,
  ]
    .filter(Boolean)
    .join("\n\n");
  return runAgent(cfg, { ...choice, system: SIDE_SYSTEM, prompt });
}
