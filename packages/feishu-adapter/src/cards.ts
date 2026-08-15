import type { ApprovalView, ChoiceView, OutputView, QuestionView, SessionView, TurnResultView } from "@pulsecortex/domain";
import { redact } from "@pulsecortex/domain";

type Card = Record<string, unknown>;
type ButtonStyle = "default" | "primary" | "danger";

function escapeMarkdown(value: string): string {
  return redact(value).replace(/([\\`*_{}\[\]()<>#+.!|~-])/gu, "\\$1");
}

function button(label: string, kind: string, token: string, value?: string, style: ButtonStyle = "default"): Card {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: style,
    width: "fill",
    behaviors: [{ type: "callback", value: { kind, token, ...(value === undefined ? {} : { value }) } }],
  };
}

function buttonRow(buttons: Card[]): Card {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((item) => ({ tag: "column", width: "auto", elements: [item] })),
  };
}

function baseCard(title: string, elements: Card[], template = "blue"): Card {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: redact(title).slice(0, 100) }, template },
    body: { direction: "vertical", padding: "12px", elements },
  };
}

function markdown(content: string): Card { return { tag: "markdown", content }; }

function elapsed(startedAt: number, at: number): string {
  const seconds = Math.max(0, Math.floor((at - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function statusCard(view: SessionView): Card {
  const commands = view.recentCommands.length ? view.recentCommands.map((name) => `- ${escapeMarkdown(name)}`).join("\n") : "- None";
  const pending = view.pendingApproval ? `\n**Approval:** ${escapeMarkdown(view.pendingApproval.kind)} - ${escapeMarkdown(view.pendingApproval.summary)}` : "";
  return baseCard(view.title, [
    markdown(`**Session:** ${escapeMarkdown(view.sessionId)}\n**Project:** ${escapeMarkdown(view.projectName)}\n**Phase:** ${escapeMarkdown(view.phase)}\n**Elapsed:** ${elapsed(view.startedAt, view.updatedAt)}${pending}\n\n${escapeMarkdown(view.safeSummary || "Waiting for Codex...")}\n\n**Recent commands**\n${commands}`),
    buttonRow([
      button("Stop", "turn.stop", view.actionTokens.stop, undefined, "danger"),
      button("Logs", "logs.show", view.actionTokens.logs),
      button("Diff", "diff.show", view.actionTokens.diff),
    ]),
  ], view.phase === "failed" ? "red" : view.phase === "completed" ? "green" : "blue");
}

export function approvalCard(view: ApprovalView): Card {
  const details: string[] = [];
  if (view.reason) details.push(`**Reason:** ${escapeMarkdown(view.reason)}`);
  if (view.command) details.push(`**Command:** \`${escapeMarkdown(view.command)}\``);
  if (view.files?.length) details.push(`**Files:**\n${view.files.map((file) => `- ${escapeMarkdown(file)}`).join("\n")}`);
  if (view.paths?.length) details.push(`**Paths:**\n${view.paths.map((item) => `- ${escapeMarkdown(item)}`).join("\n")}`);
  if (view.network?.length) details.push(`**Destinations:**\n${view.network.map((item) => `- ${escapeMarkdown(item.protocol)}://${escapeMarkdown(item.host)}${item.port ? `:${item.port}` : ""}`).join("\n")}`);
  details.push(`**Expires:** ${new Date(view.expiresAt).toISOString()}`);
  return baseCard(view.title, [
    markdown(details.join("\n\n")),
    buttonRow([
      button("Allow once", "approval.accept", view.actionTokens.accept, undefined, "primary"),
      button("Deny", "approval.decline", view.actionTokens.decline, undefined, "danger"),
      button("Stop turn", "turn.stop", view.actionTokens.cancel),
    ]),
  ], "orange");
}

export function resultCard(view: TurnResultView): Card {
  return baseCard(view.title, [
    markdown(`**Session:** ${escapeMarkdown(view.sessionId)}\n**Status:** ${escapeMarkdown(view.status)}\n**Project:** ${escapeMarkdown(view.projectName)}\n**Changed files:** ${view.changedFileCount}\n**Tests:** ${escapeMarkdown(view.testSummary || "Not reported")}\n\n${escapeMarkdown(view.summary)}`),
    buttonRow([
      button("Diff", "diff.show", view.actionTokens.diff),
      button("Logs", "logs.show", view.actionTokens.logs),
      button("Continue", "session.continue", view.actionTokens.continue, undefined, "primary"),
      button("New task", "task.new", view.actionTokens.newTask),
    ]),
  ], view.status === "completed" ? "green" : "red");
}

export function choiceCard(view: ChoiceView): Card {
  const elements: Card[] = [];
  if (view.description) elements.push(markdown(escapeMarkdown(view.description)));
  for (const choice of view.choices.slice(0, 20)) {
    elements.push({ tag: "hr" });
    if (choice.description) elements.push(markdown(`**${escapeMarkdown(choice.label)}**\n${escapeMarkdown(choice.description)}`));
    elements.push(buttonRow([button(choice.label, view.actionKind, choice.token, choice.value, "primary")]));
  }
  if (view.choices.length > 20) elements.push(markdown(`[Showing 20 of ${view.choices.length} choices]`));
  return baseCard(view.title, elements);
}

export function questionCard(view: QuestionView): Card {
  const elements: Card[] = [markdown(escapeMarkdown(view.question))];
  if (view.options.length) elements.push(buttonRow(view.options.slice(0, 8).map((option) => button(option.label, "input.answer", option.token, option.value, "primary"))));
  if (view.freeformAccepted) elements.push(markdown("Reply in this direct chat with your answer."));
  return baseCard(view.title, elements, "purple");
}

export function outputCard(view: OutputView): Card {
  const buttons: Card[] = [];
  if (view.previousToken) buttons.push(button("Previous", view.actionKind, view.previousToken));
  if (view.nextToken) buttons.push(button("Next", view.actionKind, view.nextToken, undefined, "primary"));
  return baseCard(`${view.title} (${view.page}/${view.totalPages})`, [markdown(`\`\`\`\n${escapeMarkdown(view.content)}\n\`\`\``), ...(buttons.length ? [buttonRow(buttons)] : [])]);
}
