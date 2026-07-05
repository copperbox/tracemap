# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

## Verifying UI changes

If your change affects the web UI and you want to confirm it end-to-end, a
headless Chromium and **all of its OS dependencies are already installed** in
this sandbox. The browser lives at the path in env `PLAYWRIGHT_BROWSERS_PATH`,
and the matching Playwright version is in env `PLAYWRIGHT_VERSION`. To drive the
app:

1. Add only the Playwright JS package (the browser itself is already downloaded):
   `npm i -D playwright@$PLAYWRIGHT_VERSION`
2. Start the dev server (e.g. `npx vite` in `web/`) and drive it with a short
   script, mocking `/api/topology` as needed.

Do **NOT** run `playwright install-deps`, download `.deb` packages, fetch system
libraries, or otherwise bootstrap a browser by hand — that is already done, and
attempting it will burn your entire context window. If UI verification still
fails for any reason, fall back to `npm run typecheck` + `npm run test`, note the
blocker in your commit message, and move on. Never spend the run fighting
browser setup.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
