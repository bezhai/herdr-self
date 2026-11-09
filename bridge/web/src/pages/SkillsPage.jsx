import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { Badge } from '../components/Badge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';

// A skill of the platform. One that every topic gets (everywhere) is placed in the working directory of each topic's agent before it
// starts; agents read the others when they need them. Only a skill that not every topic gets can be removed, so that a click cannot take
// one away from every topic. Editing reads the skill with its files first (see SkillDialog).
function SkillCard({ skill: s, refresh, toast, openSkill }) {
  async function act(path, body, message) {
    await request(path, body);
    if (message) toast(message);
    await refresh();
  }
  async function edit() {
    openSkill(await request(`/skills/read?name=${encodeURIComponent(s.name)}`));
  }
  const flag = { name: s.name, everywhere: !s.everywhere };
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="skill" /></span>
        <div className="card-title"><strong>{s.name}</strong></div>
        <Badge tone={s.everywhere ? 'ok' : 'neutral'}>{s.everywhere ? '所有项目都带' : '按需读取'}</Badge>
        <div className="card-actions">
          <ActionButton run={() => act('/skills/everywhere', flag, `${s.name} ${s.everywhere ? '已取消' : '已设为'}所有项目都带`)} onError={toast}>
            {s.everywhere ? '取消所有项目都带' : '设为所有项目都带'}
          </ActionButton>
          <ActionButton run={edit} onError={toast}>编辑</ActionButton>
          {!s.everywhere && <ActionButton className="text-button danger" run={() => act('/skills/remove', { name: s.name })} onError={toast}>删除</ActionButton>}
        </div>
      </div>
      <div className="card-detail"><span>{s.description}</span></div>
    </article>
  );
}

export function SkillsPage({ state, refresh, toast, openSkill }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>Agent 的 skill</h2></div>
      <div className="stack">
        {state.skills.length
          ? state.skills.map((s) => <SkillCard key={s.name} skill={s} refresh={refresh} toast={toast} openSkill={openSkill} />)
          : <EmptyState icon="skill" title="暂无 skill" />}
      </div>
    </section>
  );
}
