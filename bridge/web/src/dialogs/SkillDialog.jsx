import { request } from '../api.js';
import { skillText } from '../model.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// What a new skill's SKILL.md starts from: the frontmatter that every skill needs.
const blank = '---\nname: \ndescription: \n---\n';

// Create a skill (none given) from its name and its SKILL.md, or edit the SKILL.md of skill, which /api/skills/read returned with its files.
// Only SKILL.md is edited here; the other files of a skill are listed, and bridge-skill imports them with the whole directory.
export function SkillDialog({ skill, onClose, onSaved }) {
  const { values, field } = useFields({ name: skill?.name || '', text: skill ? skillText(skill) : blank });
  const others = skill ? Object.keys(skill.files).filter((p) => p !== 'SKILL.md') : [];

  async function save() {
    await request('/skills/save', { name: values.name, text: values.text, create: !skill });
    onSaved();
  }

  return (
    <FormDialog title={skill ? `编辑 ${skill.name}` : '新建 skill'} submitLabel="保存" className="skill-dialog" onSubmit={save} onClose={onClose}>
      {!skill && <label>skill 名称<input className="mono" required placeholder="例如：deploy-notes" {...field('name')} /></label>}
      <label>SKILL.md<textarea className="mono" required rows="18" spellCheck="false" {...field('text')} /></label>
      {others.length > 0 && (
        <fieldset>
          <legend>其他文件</legend>
          <ul className="skill-files">{others.map((p) => <li key={p}>{p}</li>)}</ul>
        </fieldset>
      )}
    </FormDialog>
  );
}
