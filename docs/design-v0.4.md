# v0.4 creator workflow

Extend the existing neutral charcoal canvas design. The user journey is generation → A/B evaluation → selected videos → ordered timeline → playable downloadable MP4. Do not imitate LibTV branding or infer its authenticated editing behavior from its public landing page.

## Timeline workspace

Open from the active canvas toolbar. A spacious dialog/workspace keeps a video stage above an ordered horizontal clip track, with clear source, trim and output controls. Each clip shows its origin node/run, selected duration, and in/out points. Reorder with pointer interaction plus explicit keyboard-accessible left/right buttons; duplicate and remove are real saved edits. Show total duration and landscape/portrait output.

A source picker lists successful video results of this board, preserving run identity and Demo status. Remote-only sources have an explicit save-and-add action; already saved sources require no download. The button must not trigger generation. Loading, invalid video, save failure and resource-limit states explain the next action. The stage scrubs through the ordered trimmed clips and advances across cuts; preserve source audio rather than always muting the product.

Timeline revision is separate from canvas revision. Save snapshots the current edit version and retains later edits. A conflict never replaces a dirty draft silently. Closing the editor attempts a save and stays open on failure/new edits/conflict; deliberate reload of remote state requires a visible user action. Add beforeunload protection for a dirty editor. Polling job or application state must not overwrite a timeline draft.

Export first saves the intended current timeline, then submits one idempotent operation. Editing during export is allowed and clearly indicates that the export uses its saved snapshot. Show pending/running/terminal state, cancel, failure with explicit new-attempt retry, and a playable local result/download. No fake progress percentages. Missing FFmpeg explains setup without disabling the rest of the canvas.

## Version comparison

Open from the active canvas/history. Choose A/B runs from this board and a node from their union. Show run time/revision/status, full prompts, provider/model and parameter differences, plus the corresponding image or video on each side. Missing/failed outputs are explicit rather than substituted with another run's artifact. Both sides prefer saved local media.

Videos have coordinated play/pause and scrub, clamped to each source's duration; indicate different lengths. Images use clear side-by-side presentation. Comparison is read-only and never invokes generation or paints a historical snapshot onto the editable canvas. Existing single-run history selection remains available.

## Accessibility and verification hooks

Use ordinary localized accessible names, labelled controls, visible focus, dialog semantics, Escape/close handling, and keyboard operations. Stable `data-testid` hooks support smoke checks without putting technical IDs into screen-reader labels:

- timeline-open, timeline-dialog, timeline-source, timeline-add, timeline-save, timeline-close, timeline-play, timeline-scrub, timeline-format, timeline-export, timeline-cancel-export.
- timeline-clip-{id}, timeline-in-{id}, timeline-out-{id}, timeline-move-left-{id}, timeline-move-right-{id}, timeline-duplicate-{id}, timeline-remove-{id}, timeline-download-{jobId}.
- compare-open, compare-dialog, compare-left-run, compare-right-run, compare-node, compare-play, compare-scrub, compare-differences, compare-close.

At 1600/1280/900 widths, controls and dialogs stay inside the viewport; long names and parameter text wrap or scroll inside their own region. Preserve existing creator home, canvas/node preview, provider settings and asset workflows.
