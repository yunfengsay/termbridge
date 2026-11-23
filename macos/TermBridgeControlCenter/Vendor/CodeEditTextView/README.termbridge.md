# CodeEditTextView

Unmodified source from CodeEditApp/CodeEditTextView 0.12.1, commit
`d7ac3f11f22ec2e820187acce8f3a3fb7aa8ddec`, MIT licensed. `UPSTREAM.json`
records every source hash. Update by copying the complete Sources directory
from a pinned upstream tag, then regenerating the hash inventory.

Only Package.swift differs: the editor imports DequeModule, so depend on that
product instead of the Collections umbrella (which links unrelated data
structures into the app). Omit the upstream SwiftLint build plugin. TextStory
and swift-collections versions are pinned; the application lockfile pins their
transitive dependencies. No runtime implementation has been patched.

Verify native code, find, lazy 100k-line layout, real Host diffs and screenshots
with NativeCodeViewTests and scripts/test-desktop-files.ts --ui before updating.
