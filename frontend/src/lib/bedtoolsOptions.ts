/**
 * Bedtools argument handling for the "Minimum overlap" setting (PLAN
 * discovery: asntech/intervene's own CLI passes `--bedtools-options`
 * straight through to every pairwise `bedtools intersect` call via
 * `helpers.py::map_bedtools_options()`). This module mirrors that parser
 * exactly, plus the three UI presets from design/reference.html mapped to
 * real flags, so the web tool and CLI agree on syntax as well as algorithm.
 */

export type BedtoolsOptionValue = true | string;
export type BedtoolsOptionsMap = Record<string, BedtoolsOptionValue>;

export type OverlapPreset = "1bp" | "fraction50" | "reciprocal50";

/** Parse a comma-separated "key=value,key=value" string, matching
 * intervene's map_bedtools_options: bare key -> boolean flag, "key=value"
 * -> valued flag, "key=true"/"key=True" -> boolean flag. */
export function parseBedtoolsOptions(optionsString: string): BedtoolsOptionsMap {
  const result: BedtoolsOptionsMap = {};
  for (const rawPair of optionsString.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      result[pair] = true;
      continue;
    }
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    result[key] = value === "true" || value === "True" ? true : value;
  }
  return result;
}

/** Render an options map to a bedtools CLI flag string, e.g. {f:"0.5",r:true} -> "-f 0.5 -r". */
export function renderBedtoolsFlags(options: BedtoolsOptionsMap): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    parts.push(value === true ? flag : `${flag} ${value}`);
  }
  return parts.join(" ");
}

export function presetToOptions(preset: OverlapPreset): BedtoolsOptionsMap {
  switch (preset) {
    case "1bp":
      return {};
    case "fraction50":
      return { f: "0.50" };
    case "reciprocal50":
      return { f: "0.50", r: true };
  }
}

/** Advanced options (when non-empty) override the preset entirely. */
export function resolveOverlapFlags(preset: OverlapPreset, advancedOptions: string): string {
  const trimmed = advancedOptions.trim();
  const options = trimmed ? parseBedtoolsOptions(trimmed) : presetToOptions(preset);
  return renderBedtoolsFlags(options);
}
