import { ExpandIcon } from './bits.tsx';
import { setCallFull, useCall, type CallView } from './call.ts';
import { Actions, Elapsed, Feed, Outcome, Usage, callDone, callStatus } from './CallPanel.tsx';

// SideCard's Call tab: the call while its full screen is folded away. The tab is there only while a call view is.
export default function CallTab({ on }: { on: boolean }) {
  const call = useCall();
  return (
    <section className="ctab" id="sc-call" role="tabpanel" aria-labelledby="sc-t-call" hidden={!on}>
      {on && call && <Body call={call} />}
    </section>
  );
}

function Body({ call }: { call: CallView }) {
  const { live, tone, text } = callStatus(call);
  const done = callDone(call);
  return (
    <>
      <div className="ct-top">
        <div className="ct-id">
          <div className={`rc-head ct-head ${tone}`}>
            <i aria-hidden="true" />
            <span role="status">{text}</span>
            {/* One timer at a time: the full screen has its own while it shows. */}
            {live && call.liveAt !== null && !call.full && <Elapsed from={call.liveAt} />}
          </div>
          <p className="ct-who" title={call.name}>Codex · {call.name}</p>
        </div>
        <button type="button" className="ct-full" title="Show the call full screen" onClick={() => setCallFull(true)}>
          <ExpandIcon out={false} />Full screen
        </button>
      </div>
      <div className="ct-body">
        {!done && call.error && <p className="vc-err" role="alert">{call.error}</p>}
        <section className="ct-act" aria-labelledby="ct-act-h">
          <h3 id="ct-act-h" className="vc-h">Latest activity</h3>
          <Feed acts={call.acts} compact />
        </section>
        <Usage usage={call.usage} />
        {done && <div className="ct-out"><Outcome call={call} /></div>}
      </div>
      <div className="ct-foot"><Actions call={call} /></div>
    </>
  );
}
