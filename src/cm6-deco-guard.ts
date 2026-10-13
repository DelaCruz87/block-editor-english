import { TEXT } from './strings';
import { Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { EditorState, Range } from '@codemirror/state';

/**
 * CM6 decorates range normalized guard (unified exit to prevent lineAt cross-border escape).
 *
 * Background: CM6 kernel is consuming decorations facet (applyTransaction → computeSlot →
 * View update period buildDecorations / posAtCoords) will be done for each DecorationSet
 * Line mapping (lineAt / lineInner). If there is from/to in the set that is out of bounds (negative/over
 * doc.length / NaN) or an illegal range from > to, the CM6 consumption period will throw
 * `Cannot read properties of undefined (reading 'length')`, and this stage is in
 * Outside of the try-catch of StateField.update, it cannot be caught by plug-ins. The only feasible solution is to
 * Do a legality normalization on DecorationSet before decorations.compute callback returns.
 * Prevent illegal ranges from entering the CM6 consumption period from the source.
 *
 * This guard only performs numerical normalization (clamp + discard is illegal) and does not change the decoration semantics:
 * - All ranges are returned as they are when they are legal (zero copy and zero overhead);
 * - Traverse using RangeSet.iter() to scan the entire range (between only callbacks and [0,docLength]
 * Intersecting ranges and completely out-of-bounds ranges will be missed and must be fully traversed):
 * - The entire paragraph is out of bounds (from > docLength or to < 0) → the entire paragraph is discarded;
 * - partial out of bounds (from < 0 or to > docLength) → clamp to [0, docLength];
 * - !Number.isFinite / from > to → discard the entire segment (does not appear in the RangeSet structure,
 * Defensive cover).
 * - Line decoration (single point from === to) and mark/replace are unified according to the above rules;
 * Zero-length single points are directly discarded when they cross the boundary (CM6 will apply line decoration to the line,
 * Out-of-bounds single points will crash lineAt during line mapping). */
export function guardDecorations(set: DecorationSet, docLength: number): DecorationSet {
  if (set === Decoration.none || !set || typeof (set as unknown as { iter?: unknown }).iter !== 'function') {
    return set;
  }
  const len = Number.isFinite(docLength) && docLength >= 0 ? docLength : 0;
  let bad = false;
  const kept: Range<Decoration>[] = [];
  try {
    const iter = set.iter();
    while (iter.value !== null) {
      const { from, to, value } = iter;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
        bad = true;
        iter.next();
        continue;
      }
      if (from > len || to < 0) {
        // The entire paragraph is outside the document → discard
        bad = true;
        iter.next();
        continue;
      }
      if (from >= 0 && to <= len) {
        // Legal: keep it as it is (rebuild Range to ensure consistent structure; line single point from===to is safe)
        kept.push(value.range(from, to));
        iter.next();
        continue;
      }
      // Partial out of bounds: clamp to [0, len]
      const nf = Math.max(0, from);
      const nt = Math.min(len, to);
      if (nf > nt) {
        bad = true;
        iter.next();
        continue;
      }
      bad = true;
      kept.push(value.range(nf, nt));
      iter.next();
    }
  } catch {
    // RangeSet iteration or reconstruction exception (structural corruption/decoration type restrictions): discard the entire set
    return Decoration.none;
  }
  if (!bad) return set;
  return Decoration.set(kept, true);
}

/**
 * decorations.compute callback safety wrapper: compute callback is used during CM6 transaction application
 * (computeSlot) execution, exceptions will bubble up directly to dispatch. Unify try-catch +
 * Range normalization ensures that any exceptions will not escape and any illegal range will not enter the consumption period.
 * When the dependent field value is abnormal/the document length is abnormal, it is downgraded and returns Decoration.none (not rendered this time).
 * Automatic recalculation and recovery of the next transaction. */
export function safeDecoCompute(
  compute: (state: EditorState) => DecorationSet,
  log: (msg: string, err?: unknown) => void = () => {}
): (state: unknown) => DecorationSet {
  return (state) => {
    try {
      const set = compute(state as EditorState);
      const doc = (state as { doc?: { length?: number } } | null | undefined)?.doc;
      const len = doc && typeof doc.length === 'number' ? doc.length : 0;
      return guardDecorations(set, len);
    } catch (e) {
      log(TEXT.message0045, e);
      return Decoration.none;
    }
  };
}
