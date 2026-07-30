<!--
Thanks for the patch. The checklist is short and every line of it exists
because something slipped through once.
-->

**What this changes, and why**

<!-- The why matters more than the what — the diff already says what. If this
     fixes a bug, give the concrete failing case with real values. -->

**Test results**

<!-- Run `npm test` and paste the counts. Baseline is 173 suites, 2306
     assertions, 0 failed. -->

```
suites: , assertions: , failed:
```

**If you added a test: how did you confirm it can fail?**

<!-- Break the code the test is meant to catch, run it, and say what it
     reported. This project has shipped assertions that were true by
     construction and caught nothing; the check is the whole point.
     e.g. "Reverting the fix in offsetLayer fails 15 assertions, the first
     being: expected 68,48, got 8,8." -->

**Checklist**

- [ ] The full suite passes in a real browser
- [ ] Any new test was verified to fail against the bug it catches
- [ ] Comments describing replaced code were updated or removed
- [ ] README's "What is not implemented" is still accurate after this change
- [ ] `doc.beginEdit(layer)` is called before any write to a layer buffer
- [ ] Authored geometry is transformed alongside pixels, if this moves layers
