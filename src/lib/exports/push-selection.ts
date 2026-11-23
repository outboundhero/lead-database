// Which leads a push covers: the part of the POST /api/bison/push-batch body the
// export popup builds from the Leads page selection. One function for both the
// push itself (export-button.tsx) and the popup's question-variable checks
// (column-selector.tsx: readiness and the "write" job of /api/questions/*), so
// the leads a question is written for are exactly the leads the push sends.
// Browser-safe and pure.

/** The push-batch body minus campaigns, force and the question variable. */
export interface PushSelection {
  selectedIds?: string[];
  filters?: unknown;
  clientTag?: string;
  pushOptions?: { includeAlreadyPushed: boolean };
  rangeFrom?: number;
  rangeTo?: number;
  maxLeads?: number;
}

export interface PushSelectionInput {
  /** The ticked rows of an "Export Selected" push; null or empty for "Export Filtered". */
  selectedIds?: string[] | null;
  /** The page's filters (with any unchecked rows as excludeIds), used when no rows are ticked. */
  filters?: unknown;
  /** The client the popup detected; null sends no client, and so no push options. */
  clientTag: string | null;
  includeAlreadyPushed: boolean;
  rangeFrom?: number;
  rangeTo?: number;
}

/**
 * A selected-rows push never sends the range fields (the route 400s on
 * selectedIds with a range rather than guessing). On the filters path both
 * bounds make a range and a lone "To" is a max-leads cap; a lone "From" is
 * never sent (the route rejects half a range).
 */
export function pushSelection(input: PushSelectionInput): PushSelection {
  const ids = Array.isArray(input.selectedIds) ? input.selectedIds : [];
  const isSelected = ids.length > 0;
  return {
    ...(isSelected ? { selectedIds: ids } : input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.clientTag
      ? { clientTag: input.clientTag, pushOptions: { includeAlreadyPushed: input.includeAlreadyPushed } }
      : {}),
    ...(!isSelected && input.rangeFrom && input.rangeTo
      ? { rangeFrom: input.rangeFrom, rangeTo: input.rangeTo }
      : !isSelected && input.rangeTo
      ? { maxLeads: input.rangeTo }
      : {}),
  };
}
