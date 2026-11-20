# Presentation sample files

All records are fictional. Text reports are pasted into Add report text; the report form does not upload PDF/TXT files directly.

1. **01_append_normal_11March.csv** - import once through Temperature. Three later normal readings; seeded10March data stays intact. Re-import deliberately demonstrates duplicate rejection.
2. **02_invalid_mixed_12March.csv** - deliberate validation failure; one invalid temperature means no row is imported.
3. **03_worked_reference_DO_NOT_IMPORT.csv** - reference copy of all14410March seed readings. They are already in a fresh demo; importing again correctly conflicts.
4. **04_maintenance_original.txt** - exact seeded maintenance report. Prefer explicit Reuse an existing report to demonstrate original/copy provenance. If pasting instead, select Maintenance report.
5. **05_restart_conflict.txt** - supplementary maintenance source with04:00restart. Paste after the original to show neutral Specialist conflict against05:30high reading.
6. **06_inspection_OPTIONAL.txt** - stock inspection fixture. Leave it out of the main missing-evidence route; optional before preparation, or on a new practice instance, to learn readiness. It reports need for assessment, not spoilage.
7. **07_correction_practice_OPTIONAL.txt** - optional literal-source correction exercise before preparation. Initially extractsREF-02; correct equipment ID toREF-01 using the complete line Verified equipment annotation: REF-01 and a reason. It is a separate exercise, not a replacement for the main original.

Follow the [worked walkthrough](../DEMO_SCRIPT.md). Keep filenames/types distinct. Never reset the normal database just to rehearse.
