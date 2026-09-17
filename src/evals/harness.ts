import { createFlueClient, type FlueConversationMessage } from '@flue/sdk';
import { createHarness, type TranscriptEvent } from 'vitest-evals/harness';
import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { localBaseUrl } from '../config.ts';
import { SnapshotSchema, type Fault } from '../tracker.ts';
import type { Fixture } from '../fixtures.ts';
import { policy, POLICY_VERSION } from '../policy.ts';
import type { TriageOutput } from './grades.ts';
import { saveArtifact } from './artifacts.ts';
import { AllocationSchema } from './schemas.ts';
import { errorMessage, JsonValueSchema, toJsonValue } from '../json.ts';
import type { Expected } from './cases.ts';

export function messageText(message: FlueConversationMessage) {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
export function transcript(messages: FlueConversationMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of messages) {
    // Preserve part order: a reply after a tool result must not appear before it.
    for (const part of message.parts) {
      if (part.type === 'text')
        events.push({ type: 'message', role: message.role, content: part.text });
      if (part.type !== 'dynamic-tool') continue;
      events.push({
        type: 'tool_call',
        id: part.toolCallId,
        name: part.toolName,
        arguments: v.parse(v.record(v.string(), JsonValueSchema), part.input ?? {}),
      });
      if (part.state === 'output-available')
        events.push({
          type: 'tool_result',
          toolCallId: part.toolCallId,
          name: part.toolName,
          content: v.parse(JsonValueSchema, part.output),
        });
      if (part.state === 'output-error')
        events.push({
          type: 'tool_result',
          toolCallId: part.toolCallId,
          name: part.toolName,
          error: { message: part.errorText },
        });
    }
  }
  return events;
}
export async function control(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}/__eval/trials${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Tracker control ${response.status}: ${await response.text()}`);
  return response.json();
}
// The harness adapts Flue to the eval runner: inputs in, observed state and transcript out.
// Expected answers stay in the test; sending them to the agent would leak the answer key.
export function createTriageHarness(options: {
  fixture: Fixture;
  fault?: Fault;
  timeoutMs?: number;
  baseUrl?: string;
  evidence?: 'live' | 'scripted-provider';
  scenario?: { caseId: string; expected: Expected };
}) {
  return createHarness<string | string[], TriageOutput>({
    name: 'flue-issue-triage',
    run: async ({ input, signal, setArtifact }) => {
      const base = localBaseUrl(options.baseUrl);
      const started = Date.now();
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 120_000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      // Every run gets fresh state. Turns inside this run share one conversation and tracker.
      const allocated = v.parse(
        AllocationSchema,
        await control(base, '', {
          method: 'POST',
          body: JSON.stringify({ fixture: options.fixture, fault: options.fault ?? 'none' }),
          signal: bounded,
        }),
      );
      const { id, snapshot: before } = allocated;
      const conversation = createFlueClient({ url: `${base}/agents/triage/${id}` });
      const turns = typeof input === 'string' ? [input] : input;
      const observations: TriageOutput['turns'] = [];
      let history: FlueConversationMessage[] = [];
      let error: Error | undefined;
      let events: TranscriptEvent[] = [];
      let after = before;
      const admissions: Awaited<ReturnType<typeof conversation.send>>[] = [];
      try {
        for (const body of turns) {
          const admission = await conversation.send({
            message: { kind: 'user', body },
            signal: bounded,
          });
          admissions.push(admission);
          // Admission means accepted, not finished. Inspect state only after the turn completes.
          await conversation.wait(admission, { signal: bounded });
          history = (await conversation.history({ signal: bounded })).messages;
          const reply = history.findLast((m) => m.role === 'assistant');
          if (!reply) throw new Error('Completed conversation has no assistant response.');
          // Read the tracker independently: neither "created!" nor a tool receipt proves a write.
          after = v.parse(SnapshotSchema, await control(base, `/${id}`, { signal: bounded }));
          observations.push({ reply: messageText(reply), after });
        }
        events = transcript(history);
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(errorMessage(cause));
        // Abort independently of the already-aborted caller signal, then preserve partial evidence.
        await conversation.abort({ signal: AbortSignal.timeout(5000) }).catch(() => {});
        history = (
          await conversation
            .history({ signal: AbortSignal.timeout(5000) })
            .catch(() => ({ messages: history }))
        ).messages;
        after = await control(base, `/${id}`)
          .then((value) => v.parse(SnapshotSchema, value))
          .catch(() => after);
      }
      const output: TriageOutput = {
        before,
        after,
        reply: observations.at(-1)?.reply ?? '',
        turns: observations,
      };
      const runtimeMetadata = history.filter((m) => m.role === 'assistant').map((m) => m.metadata);
      const applicationExecution = error ? 'error' : 'completed';
      let cleanupError: string | null = null;
      // Evidence is already captured above. Close before saving so cleanup failures are included
      // in the artifact. Keep the application error primary if both execution and cleanup fail.
      try {
        await control(base, `/${id}`, { method: 'DELETE' });
      } catch (cause) {
        cleanupError = errorMessage(cause);
        error ??= new Error(`Trial cleanup failed: ${cleanupError}`);
      }
      const artifact = {
        schemaVersion: 1,
        trialId: id,
        experimentId: process.env.FAFO_RUN_ID ?? null,
        // The article smoke test executes the unchanged example with a scripted provider.
        evidence:
          options.evidence ??
          (process.env.FAFO_SCRIPTED_PROVIDER === '1' ? 'scripted-provider' : 'live'),
        fixture: options.fixture,
        scenario: options.scenario ?? null,
        fixtureVersion: 1,
        fault: options.fault ?? 'none',
        policyVersion: POLICY_VERSION,
        policyHash: createHash('sha256').update(policy).digest('hex'),
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        timeoutMs: options.timeoutMs ?? 120_000,
        input,
        output,
        admissions,
        history,
        runtimeMetadata,
        routing: 'OpenRouter defaults; upstream selection may vary',
        costUsd: null, // Unmeasured cost is unknown, not zero; retain provider usage above.
        applicationExecution,
        cleanup: { status: cleanupError === null ? 'completed' : 'error', error: cleanupError },
        execution: error ? 'error' : 'completed',
        error: error?.message ?? null,
      };
      try {
        // Save execution and cleanup failures too. A badge alone cannot explain what broke.
        const file = await saveArtifact(id, artifact);
        setArtifact('trial', toJsonValue({ file, ...artifact }));
      } catch (cause) {
        if (error)
          throw new AggregateError(
            [error, cause],
            `${error.message}; artifact retention also failed: ${errorMessage(cause)}`,
          );
        throw cause;
      }
      // Partial evidence helps debugging; it must not turn an execution error into a completed eval.
      if (error) throw error;
      return { output, events };
    },
  });
}
