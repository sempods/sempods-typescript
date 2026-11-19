import type { SVGProps } from 'react';
import { Trash2 } from 'lucide-react';

export interface DeleteIconProps extends Omit<
  SVGProps<SVGSVGElement>,
  'ref' | 'children' | 'role' | 'aria-hidden' | 'aria-label' | 'aria-labelledby'
> {
  /** Width and height; `1rem` by default, so it follows the root font size. */
  readonly size?: string | number;
}

/**
 * The shared delete glyph, Lucide's `Trash2`: the same outline as the SDK's
 * `RemoveButton` shows without children, for a bulk action beside it, for
 * example `<ActionButton><DeleteIcon /> Clear done tasks</ActionButton>`.
 * It is always decorative (`aria-hidden`): the button around it names what
 * it deletes. A kit button sizes an icon without a `size-*` class to 1rem as
 * well; the default matters outside them.
 */
export function DeleteIcon({ size = '1rem', ...props }: DeleteIconProps) {
  return <Trash2 size={size} {...props} aria-hidden="true" />;
}
