import { useState } from 'react';
import type { ConsoleProject } from '../../../console-state.ts';
import type { Skill } from '../../../state.ts';
import { request } from '../api.ts';
import { workModes } from '../model.ts';
import { FormDialog, useFields } from './FormDialog.tsx';

// Create a project (none given) or edit one: its repositories, one address per line, how its topics share the directory, and the skills that
// are placed for its topics besides the ones loaded by default. Those need no picking, so they are offered only where the project already holds one.
// An empty description of a project with repositories is made from their READMEs after saving.
export function ProjectDialog({ project, skills, onClose, onSaved }: { project?: ConsoleProject, skills: Skill[], onClose: () => void, onSaved: () => void }) {
  const { values, field } = useFields({
    name: project?.name || '',
    description: project?.description || '',
    repos: project?.repos.join('\n') || '',
    workMode: project?.workMode || 'isolated',
  });
  const [picked, setPicked] = useState(project?.skills || []);
  const offered = skills.filter((s) => !s.preload || project?.skills.includes(s.name));

  const toggle = (name: string) => setPicked((names) => (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]));

  async function save() {
    await request('/projects/save', {
      id: project?.id,
      ...values,
      repos: values.repos.split(/\s+/).filter(Boolean),
      skills: skills.filter((s) => picked.includes(s.name)).map((s) => s.name),
    });
    onSaved();
  }

  return (
    <FormDialog title={project ? '编辑项目' : '新建项目'} submitLabel="保存" onSubmit={save} onClose={onClose}>
      <label>项目名称<input required placeholder="例如：genvi" {...field('name')} /></label>
      <label>描述<textarea rows={3} {...field('description')} /></label>
      <label>仓库<textarea className="mono" rows={3} spellCheck="false" placeholder="每行一个地址" {...field('repos')} /></label>
      <label>话题目录
        <select {...field('workMode')}>
          {workModes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      {offered.length > 0 && (
        <fieldset>
          <legend>Skills</legend>
          {offered.map((s) => (
            <label key={s.name} className="checkbox"><input type="checkbox" checked={picked.includes(s.name)} onChange={() => toggle(s.name)} /><span>{s.name}</span></label>
          ))}
        </fieldset>
      )}
    </FormDialog>
  );
}
