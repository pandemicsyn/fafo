# FAFO: Learn to Write Evals

[Read the blog post](https://neonronin.sh/blog/learn-to-write-evals), or have your coding agent teach you.

Learn evals by messing with them: inspect failures, fix bad graders, and try your own cases. The included `learn-evals` skill walks you through it.

Trying Jev as a judge? Start with `npm run evals:judge -- --examples --dry-run` and the [Jev experiment guide](docs/jev.md). The worked examples show focused context, three question types, decisions composed in code, real captured results, and sampling saved application runs. Keep `TYPESAFE_API_KEY` in the ignored `.dev.vars` file.

## Get started

```sh
git clone https://github.com/pandemicsyn/fafo.git
cd fafo
```

Open your coding agent in this directory and ask:

> Use the learn-evals skill to teach me evals. Start with lesson 1. Let me predict the result and try the exercise before showing me the answer.

You can also use `/learn-evals` where supported. Ask for a hint, skip something you already know, or say “apply this to my app.”

The skill comes with the repo. Your agent can help install dependencies when you reach the first runnable example (Node 22.19+ required). If it can't find the skill, ask it to read [`.agents/skills/learn-evals/SKILL.md`](.agents/skills/learn-evals/SKILL.md).

Want the tutor available in another project? Optionally install it with `npx skills add pandemicsyn/fafo --skill learn-evals`. The [official vitest-evals skill](https://vitest-evals.sentry.dev/docs/agent-skill) adds library-specific guidance when you need it: `npx skills add getsentry/vitest-evals`.

Lesson 3 in progress: inspecting the repaired grader's results with a coding agent.

![The learn-evals skill in Kilo CLI, showing lesson 3's result table and asking the learner why a false success claim should be rejected.](docs/images/lesson-3-in-progress.png)
