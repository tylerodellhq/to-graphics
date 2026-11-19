# TO Graphics (Premiere Pro UXP panel)

Tyler's replacement for Premiere's Graphics Templates panel. Same setup as Something Something HQ:
UXP, manifest v5, Premiere 25.6+, updates through Creative Cloud (.ccx).

- `plugin/` is the plugin exactly as packed into `TOGraphics.ccx` (manifest.json at its root).
- `python3 build.py "<notes>"` packs it and writes `latest.json`. The panel reads
  `https://raw.githubusercontent.com/tylerodellhq/to-graphics/main/latest.json` on open and offers the
  update when `version` is higher than the installed one, so the repo must be public.

## Every change pushed to main
1. Bump `version` in `plugin/manifest.json`.
2. `python3 build.py "<one plain-English line for Tyler>"`, then commit `TOGraphics.ccx` and `latest.json` with the code.
3. Add the change to `CHANGELOG.md`.
4. `node --check` every .js file, and render `plugin/index.html` headless with mocks before pushing:
   a broken push breaks the panel on Tyler's Mac.

## How it works
- Templates = the .mogrt files in Premiere's local templates folder (`SequenceEditor.getInstalledMogrtPath()`,
  normally `~/Library/Application Support/Adobe/Common/Motion Graphics Templates`). Premiere's built-in
  templates live elsewhere, so they never show.
- Panel data (clients, types, hidden, favourites, previews) lives in `<that folder>/.to-graphics/`
  (`library.json`, `thumbs/`), so it survives reinstalls. Keyed by the file's path in the folder.
- Each .mogrt is unzipped with fflate (lib/) to read `definition.json`: name, frame size (shape), length,
  control names. Captioneer templates mention Captioneer in definition.json or project.aegraphic; they
  are hidden unless Settings > Show caption templates is on.
- Previews: a scratch sequence ("TO Graphics previews (deleted automatically)") is sized to each template,
  the template is inserted, `Exporter.exportSequenceFrame` renders frames at 50/75/30% and the largest JPEG
  (busiest frame) is kept. Anything new in the project afterwards is removed.
- New version: when a template's file changes (AE export with the same name, Add with a clash, or
  More > Choose new version), the preview is remade and the panel offers to swap it into the open
  project: every timeline item named like the template (and sharing a control name) is removed, the new
  one placed at the same start/track, trimmed to the same end, and its settings copied by component +
  param display name. Keyframed settings are left at the new defaults.
- Rename (More): rewrites capsuleName in definition.json + renames the file, and re-stamps it so it is not seen as a new version.
- UXP has no drag and drop, so templates are added with Add (file picker) or straight from AE.

## Design (1.1.0 pass)
Tyler Odell Creative colours: Night background, Bone text, Wasabi (#E9F056) for the main action and
selection, Sky (#8FCAFF) only for "Updated". One Wasabi button per area. TO Grit (fonts/) for headings,
Archivo for text. Filters must wrap or be dropdowns: never clip text or scroll sideways (Tyler hated it).

## Don't
- Never put client names in code or anything pushed: they live only in library.json on Tyler's Mac.
