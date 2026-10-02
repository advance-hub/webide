import { type Workspace } from '../../domain/models';
import { Store, hash, now, publicEntity } from '../../platform/store';
import { HTTPError, requireString } from '../../platform/validation';

import type { AccessControl } from '../accounts/access';

/** 使用已经登录并验证的账户邀请成员，昵称不作为授权标识。 */
export class WorkspaceSharing {
  constructor(
    private readonly store: Store,
    private readonly access: AccessControl,
  ) {}

  visible(actor: string): Workspace[] {
    return this.store
      .list<Workspace>('workspace')
      .filter((w) => !w.archived && (w.owner === actor || w.members?.includes(actor)));
  }

  describe(workspace: Workspace, actor: string) {
    const { members: _members, memberNames: _names, ...value } = publicEntity(workspace);
    return {
      ...value,
      accessRole: workspace.owner === actor ? ('owner' as const) : ('member' as const),
      projectName: this.store.get('project', workspace.projectId)?.name,
      ownerName: this.store.get('user', workspace.owner)?.name || '本地开发者',
      members: (workspace.members || []).map(hash),
      memberNames: (workspace.members || []).map(
        (id) => this.store.get('user', id)?.username || this.store.get('user', id)?.name || hash(id),
      ),
    };
  }

  change(
    id: string,
    actor: string,
    input: Record<string, unknown>,
  ): { workspace: Workspace; member: string; removed: boolean } {
    const workspace = this.access.workspace(id, actor);
    if (workspace.archived) {
      throw new HTTPError(409, '工作区已归档');
    }
    const username = requireString(input.username, '成员登录用户名或账户标识', 256);
    if (input.remove !== undefined && typeof input.remove !== 'boolean') {
      throw new HTTPError(400, '成员操作无效');
    }
    const users = this.store
      .list('user')
      .filter(
        (user) =>
          hash(user.id) === username || user.username === username || (!user.username && user.name === username),
      );
    if (users.length !== 1) {
      throw new HTTPError(
        users.length ? 409 : 404,
        users.length ? '用户名不唯一，请使用账户标识' : '成员需先登录工作台',
      );
    }
    const member = users[0].id;
    if (member === actor) {
      throw new HTTPError(400, '不能将所有者添加为成员或移除所有者');
    }
    const members = new Set(workspace.members || []);
    const removed = input.remove === true;
    if (removed) {
      members.delete(member);
    } else {
      if (!members.has(member) && members.size >= 4) {
        throw new HTTPError(409, '每个工作区最多五人同时协作（含所有者）');
      }
      members.add(member);
    }
    workspace.members = [...members];
    workspace.updatedAt = now();
    return { workspace, member, removed };
  }
}
