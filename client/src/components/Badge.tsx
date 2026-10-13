import { humanize, toneFor } from '../format';

interface Props {
  value: string | null | undefined;
  label?: string; // override the displayed text
}

export function Badge({ value, label }: Props) {
  return <span className={`badge badge-${toneFor(value)}`}>{label ?? humanize(value)}</span>;
}
