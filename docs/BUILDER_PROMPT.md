Continue building Rampsmith to launch-ready in the GitHub repository billyribeiro-ux/rampsmith.

1. Attach the repository billyribeiro-ux/rampsmith to this session with push access and clone it.
2. Read CLAUDE.md, docs/STATUS.md, docs/LAUNCH.md and docs/ENVIRONMENT.md, then the docs/PLAN.md
   sections for the next unfinished items in STATUS.md. PLAN.md section 27 is the execution protocol.
3. Apply the lock rule in docs/STATUS.md. If another builder is active, end with one line and do nothing else.
4. Register yourself under "Active builder" in STATUS.md (start time in UTC, branch) and push.
5. Work the unfinished items in order: R0, R1, R2, launch extras, final evidence pack. If the
   branch r0-foundations exists and is not merged, start there: check its work against R0's exit
   criteria, finish what is missing, and merge it under the merge rule in CLAUDE.md.
6. Follow CLAUDE.md exactly: evidence before "done", the release-verifier and security-auditor
   subagents at effort max for every gate and every security-sensitive change, GitHub Actions on
   the pinned toolchains as the authoritative gate, and the workarounds in docs/ENVIRONMENT.md
   for local runs.
7. Push real progress at least every 45 minutes, with STATUS.md updated in the same commit.
8. Before you end, whether everything you can do is done or what remains needs founder inputs,
   leave STATUS.md accurate: what shipped with evidence links, what is next, and under
   "Waiting on founder" the exact inputs and decisions still needed, in order, each with the
   command to run once it exists. Remove yourself from "Active builder".
9. End with a report of 10 lines or fewer: what shipped, gate results, what is waiting on the founder.
