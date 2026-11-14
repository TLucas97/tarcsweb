import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Node = { type: string; value?: string; url?: string; children?: Node[] };

// GFM handles explicit links and URLs; only domain/path references need an HTTPS default.
function bareDomains() {
  return (tree: Node) => {
    const walk = (parent: Node) => {
      if (!parent.children || parent.type === 'link' || parent.type === 'linkReference') return;
      parent.children = parent.children.flatMap((node): Node[] => {
        if (node.type !== 'text' || node.value === undefined) {
          walk(node);
          return [node];
        }
        const out: Node[] = [];
        let end = 0;
        for (const match of node.value.matchAll(/(?<![\w@/:.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}\/[^\s<>]+/gi)) {
          let label = match[0].replace(/[.,!?;:'"]+$/, '');
          while (label.endsWith(')') && label.split(')').length > label.split('(').length) label = label.slice(0, -1);
          out.push({ type: 'text', value: node.value.slice(end, match.index) });
          out.push({ type: 'link', url: `https://${label}`, children: [{ type: 'text', value: label }] });
          end = match.index + label.length;
        }
        return out.length ? [...out, { type: 'text', value: node.value.slice(end) }] : [node];
      });
    };
    walk(tree);
  };
}

const plugins = [remarkGfm, bareDomains];
const elements = ['a', 'code', 'strong', 'em', 'del', 'br'];
const components: Components = {
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>,
};

// No block wrappers, images, raw HTML or dependency on the conversation Markdown renderer.
export function InlineText({ children }: { children: string }) {
  return <Markdown remarkPlugins={plugins} components={components} allowedElements={elements} unwrapDisallowed>{children}</Markdown>;
}
