import { defineUi } from './define.ts';
import { schema, type Data } from './topic.schema.ts';

// A section heading, not a visual: no Card frame, no actions and no entrance, so it reads like the text around it.
function Topic({ b }: { b: Data }) {
  return <h2 className="ub-topic" dir="auto">{b.title.trim()}</h2>;
}

export const topic = defineUi({ schema, Component: Topic, label: 'Topic…' });
