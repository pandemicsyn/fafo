import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createTriageHarness } from './harness.ts';
import { selectCases } from './cases.ts';
import { gradeOutcome } from './grades.ts';
const repetitions = Number(process.env.FAFO_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
  throw new Error('Repetitions must be 1–5.');
for (const scenario of selectCases(
  process.env.FAFO_CASES ?? 'new-search,true-duplicate,missing-observation',
)) {
  describeEval(
    `${scenario.id} [${scenario.slice}]`,
    {
      harness: createTriageHarness({
        fixture: scenario.fixture,
        fault: scenario.fault,
        scenario: { caseId: scenario.id, expected: scenario.expected },
      }),
    },
    (it) => {
      // Repetitions are independent, recorded trials. Retrying until green hides unreliability.
      for (let trial = 1; trial <= repetitions; trial++) {
        it(`trial ${trial}`, async ({ run }) => {
          const result = await run(scenario.turns);
          const grades = gradeOutcome(result.output, scenario.expected);
          // Soft assertions collect every broken criterion while still failing this trial.
          for (const grade of grades)
            expect.soft(grade.status, `${grade.name}: ${grade.reason}`).toBe('pass');
          if (scenario.beforeFinal) {
            // A correct final state can hide a premature write before the user supplied missing facts.
            for (const turn of result.output.turns.slice(0, -1)) {
              const interim = { ...result.output, reply: turn.reply, after: turn.after };
              for (const grade of gradeOutcome(interim, scenario.beforeFinal))
                expect.soft(grade.status, `Before clarification: ${grade.reason}`).toBe('pass');
            }
          }
          if (['create', 'comment'].includes(scenario.expected.action)) {
            // LESSON 5: solve exercises/trajectory.ts offline first. This live suite keeps its
            // original limited check; learner exercise edits do not silently change live grading.
            // Afterward, you can explicitly wire your stronger check into duplicate cases here.
            // This narrow process check proves search ran, not that it ran before the write or
            // found the right duplicate. State graders above check the actual result.
            expect(
              toolCalls(result).some((call) => call.name === 'search_issues'),
              'Search must actually run.',
            ).toBe(true);
          }
        });
      }
    },
  );
}
