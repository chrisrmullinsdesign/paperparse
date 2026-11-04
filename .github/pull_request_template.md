## What this changes, and why

<!-- One paragraph. If it corrects a claim, quote the claim and say what falsified it. -->

## How it was verified

<!-- Commands run and what they printed. "Tests pass" is not enough when the change
     is to a number, a figure, or a security property: show the check that proves it. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass locally
- [ ] Any README figure this touches is still recomputed by `test/readme.test.ts`, or the README says why it can't be
- [ ] No fixture, seed, or FormSpec geometry changed, **or** this PR says so, re-records, and states what it cost
- [ ] No number, run, or screenshot in this PR was simulated or estimated
- [ ] Secrets/PII/EXIF sweep run over every added file, images and `runs/` included — result:
- [ ] If an agent helped write this, its commits carry a `Co-Authored-By` trailer
