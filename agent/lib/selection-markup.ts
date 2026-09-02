export const SELECTION_FULL_RE = /<chart_selection\s[^>]*>[\s\S]*?<\/chart_selection>\s*/;
export const SELECTION_REF_RE = /<chart_selection_ref\s[^>]*\/>\s*/;

export function stripSelectionMarkup(text: string): string {
  return text.replace(SELECTION_FULL_RE, '').replace(SELECTION_REF_RE, '');
}
