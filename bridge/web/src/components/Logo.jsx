export function Logo({ tiny = false }) {
  return <span className={tiny ? 'logo tiny' : 'logo'}><svg><use href="#i-herdr" /></svg></span>;
}

export function Brand() {
  return <a className="brand" href="/"><Logo /><span className="brand-name">herdr<b>bridge</b></span></a>;
}
