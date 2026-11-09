// Icon from the SVG sprite in index.html.
export function Icon({ name }: { name: string }) {
  return <svg className="i" aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}
