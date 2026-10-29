// KaTeX's lazy chunk: the library, its stylesheet and fonts, and its copy handler (a copied formula gives its TeX).
import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'katex/contrib/copy-tex';

// trust:false keeps \href, \url and \html* from emitting links or attributes; the limits stop runaway macros.
export const typeset = (tex: string) =>
  katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 1000, errorColor: 'var(--red)' });
