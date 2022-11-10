import { Knex } from 'knex';
import { Logger, LogProvider } from '../logger';

import NotFoundError from '../error/notfound-error';
import { IEnvironment, IProject, IProjectWithCount } from '../types/model';
import {
    IProjectHealthUpdate,
    IProjectInsert,
    IProjectEnvironmentConfig,
    IProjectQuery,
    IProjectStore,
    IUpdateProjectEnvironmentConfig,
} from '../types/stores/project-store';
import { DEFAULT_ENV } from '../util/constants';
import metricsHelper from '../util/metrics-helper';
import { DB_TIME } from '../metric-events';
import EventEmitter from 'events';

const COLUMNS = [
    'id',
    'name',
    'description',
    'created_at',
    'health',
    'updated_at',
    'change_request_enabled',
];
const TABLE = 'projects';

export interface IEnvironmentProjectLink {
    environmentName: string;
    projectId: string;
    changeRequestsEnabled?: string;
}

export interface IProjectMembersCount {
    count: number;
    project: string;
}

class ProjectStore implements IProjectStore {
    private db: Knex;

    private logger: Logger;

    private timer: Function;

    constructor(db: Knex, eventBus: EventEmitter, getLogger: LogProvider) {
        this.db = db;
        this.logger = getLogger('project-store.ts');
        this.timer = (action) =>
            metricsHelper.wrapTimer(eventBus, DB_TIME, {
                store: 'project',
                action,
            });
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    fieldToRow(data): IProjectInsert {
        return {
            id: data.id,
            name: data.name,
            description: data.description,
        };
    }

    destroy(): void {}

    async exists(id: string): Promise<boolean> {
        const result = await this.db.raw(
            `SELECT EXISTS(SELECT 1 FROM ${TABLE} WHERE id = ?) AS present`,
            [id],
        );
        const { present } = result.rows[0];
        return present;
    }

    async getProjectsWithCounts(
        query?: IProjectQuery,
    ): Promise<IProjectWithCount[]> {
        const projectTimer = this.timer('getProjectsWithCount');
        let projects = this.db(TABLE)
            .select(
                this.db.raw(
                    'projects.id, projects.name, projects.description, projects.health, projects.updated_at, projects.change_request_enabled, count(features.name) AS number_of_features',
                ),
            )
            .leftJoin('features', 'features.project', 'projects.id')
            .groupBy('projects.id')
            .orderBy('projects.name', 'asc');
        if (query) {
            projects = projects.where(query);
        }
        const projectAndFeatureCount = await projects;

        const projectsWithFeatureCount = projectAndFeatureCount.map(
            this.mapProjectWithCountRow,
        );
        projectTimer();
        const memberTimer = this.timer('getMemberCount');

        const memberCount = await this.getMembersCount();
        memberTimer();
        const memberMap = new Map<string, number>(
            memberCount.map((c) => [c.project, Number(c.count)]),
        );
        return projectsWithFeatureCount.map((r) => {
            return { ...r, memberCount: memberMap.get(r.id) };
        });
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    mapProjectWithCountRow(row): IProjectWithCount {
        return {
            name: row.name,
            id: row.id,
            description: row.description,
            health: row.health,
            featureCount: Number(row.number_of_features) || 0,
            memberCount: Number(row.number_of_users) || 0,
            updatedAt: row.updated_at,
            changeRequestsEnabled: row.change_request_enabled || false,
        };
    }

    async getAll(query: IProjectQuery = {}): Promise<IProject[]> {
        const rows = await this.db
            .select(COLUMNS)
            .from(TABLE)
            .where(query)
            .orderBy('name', 'asc');

        return rows.map(this.mapRow);
    }

    async get(id: string): Promise<IProject> {
        return this.db
            .first(COLUMNS)
            .from(TABLE)
            .where({ id })
            .then(this.mapRow);
    }

    async hasProject(id: string): Promise<boolean> {
        const result = await this.db.raw(
            `SELECT EXISTS(SELECT 1 FROM ${TABLE} WHERE id = ?) AS present`,
            [id],
        );
        const { present } = result.rows[0];
        return present;
    }

    async updateHealth(healthUpdate: IProjectHealthUpdate): Promise<void> {
        await this.db(TABLE)
            .where({ id: healthUpdate.id })
            .update({ health: healthUpdate.health, updated_at: new Date() });
    }

    async create(project: IProjectInsert): Promise<IProject> {
        const row = await this.db(TABLE)
            .insert(this.fieldToRow(project))
            .returning('*');
        return this.mapRow(row[0]);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    async update(data): Promise<void> {
        try {
            await this.db(TABLE)
                .where({ id: data.id })
                .update(this.fieldToRow(data));
        } catch (err) {
            this.logger.error('Could not update project, error: ', err);
        }
    }

    async importProjects(
        projects: IProjectInsert[],
        environments?: IEnvironment[],
    ): Promise<IProject[]> {
        const rows = await this.db(TABLE)
            .insert(projects.map(this.fieldToRow))
            .returning(COLUMNS)
            .onConflict('id')
            .ignore();
        if (rows.length > 0) {
            await this.addDefaultEnvironment(rows);
            environments
                ?.filter((env) => env.name !== DEFAULT_ENV)
                .forEach((env) => {
                    projects.forEach((project) => {
                        this.addEnvironmentToProject(project.id, env.name);
                    });
                });
            return rows.map(this.mapRow);
        }
        return [];
    }

    async addDefaultEnvironment(projects: any[]): Promise<void> {
        const environments = projects.map((p) => ({
            project_id: p.id,
            environment_name: DEFAULT_ENV,
            change_request_enabled: p.change_request_enabled,
        }));
        await this.db('project_environments')
            .insert(environments)
            .onConflict(['project_id', 'environment_name'])
            .ignore();
    }

    async deleteAll(): Promise<void> {
        await this.db(TABLE).del();
    }

    async delete(id: string): Promise<void> {
        try {
            await this.db(TABLE).where({ id }).del();
        } catch (err) {
            this.logger.error('Could not delete project, error: ', err);
        }
    }

    async getProjectLinksForEnvironments(
        environments: string[],
    ): Promise<IEnvironmentProjectLink[]> {
        let rows = await this.db('project_environments')
            .select([
                'project_id',
                'environment_name',
                'change_request_enabled',
            ])
            .whereIn('environment_name', environments);
        return rows.map(this.mapLinkRow);
    }

    async deleteEnvironmentForProject(
        id: string,
        environment: string,
    ): Promise<void> {
        await this.db('project_environments')
            .where({
                project_id: id,
                environment_name: environment,
            })
            .del();
    }

    async addEnvironmentToProject(
        id: string,
        environment: string,
    ): Promise<void> {
        const project = await this.get(id);
        await this.db('project_environments')
            .insert({
                project_id: id,
                environment_name: environment,
                change_request_enabled: project.changeRequestsEnabled,
            })
            .onConflict(['project_id', 'environment_name'])
            .ignore();
    }

    async addEnvironmentToProjects(
        environment: string,
        projects: string[],
    ): Promise<void> {
        const rows = projects.map(async (projectId) => {
            const project = await this.get(projectId);
            return {
                project_id: projectId,
                environment_name: environment,
                change_request_enabled: project.changeRequestsEnabled || false,
            };
        });

        await this.db('project_environments')
            .insert(rows)
            .onConflict(['project_id', 'environment_name'])
            .ignore();
    }

    async getEnvironmentsForProject(id: string): Promise<string[]> {
        return this.db('project_environments')
            .where({
                project_id: id,
            })
            .innerJoin(
                'environments',
                'project_environments.environment_name',
                'environments.name',
            )
            .orderBy('environments.sort_order', 'asc')
            .orderBy('project_environments.environment_name', 'asc')
            .pluck('project_environments.environment_name');
    }

    async getChangeRequestConfigForProject(
        id: string,
    ): Promise<IProjectEnvironmentConfig[]> {
        return this.db('project_environments')
            .select(
                'project_environments.environment_name as environment',
                'environments.type as type',
                'project_environments.change_request_enabled as changeRequestEnabled',
            )
            .where({
                project_id: id,
            })
            .innerJoin(
                'environments',
                'project_environments.environment_name',
                'environments.name',
            )
            .orderBy('environments.sort_order', 'asc')
            .orderBy('project_environments.environment_name', 'asc');
    }

    async updateProjectEnvironmentConfig(
        id: string,
        data: IUpdateProjectEnvironmentConfig,
    ): Promise<void> {
        try {
            await this.db('project_environments')
                .where({ project_id: id, environment_name: data.environment })
                .update({ change_request_enabled: data.changeRequestsEnabled });
        } catch (err) {
            this.logger.error(
                'Could not update project environment, error: ',
                err,
            );
        }
    }

    async getMembersCount(): Promise<IProjectMembersCount[]> {
        const members = await this.db
            .select('project')
            .from((db) => {
                db.select('user_id', 'project')
                    .from('role_user')
                    .leftJoin('roles', 'role_user.role_id', 'roles.id')
                    .where((builder) => builder.whereNot('type', 'root'))
                    .union((queryBuilder) => {
                        queryBuilder
                            .select('user_id', 'project')
                            .from('group_role')
                            .leftJoin(
                                'group_user',
                                'group_user.group_id',
                                'group_role.group_id',
                            );
                    })
                    .as('query');
            })
            .groupBy('project')
            .count('user_id');
        return members;
    }

    async getProjectsByUser(userId: number): Promise<string[]> {
        const members = await this.db
            .from((db) => {
                db.select('project')
                    .from('role_user')
                    .leftJoin('roles', 'role_user.role_id', 'roles.id')
                    .where('type', 'root')
                    .andWhere('name', 'Editor')
                    .andWhere('user_id', userId)
                    .union((queryBuilder) => {
                        queryBuilder
                            .select('project')
                            .from('group_role')
                            .leftJoin(
                                'group_user',
                                'group_user.group_id',
                                'group_role.group_id',
                            )
                            .where('user_id', userId);
                    })
                    .as('query');
            })
            .pluck('project');
        return members;
    }

    async getMembersCountByProject(projectId: string): Promise<number> {
        const members = await this.db
            .from((db) => {
                db.select('user_id')
                    .from('role_user')
                    .leftJoin('roles', 'role_user.role_id', 'roles.id')
                    .where((builder) =>
                        builder
                            .where('project', projectId)
                            .whereNot('type', 'root'),
                    )
                    .union((queryBuilder) => {
                        queryBuilder
                            .select('user_id')
                            .from('group_role')
                            .leftJoin(
                                'group_user',
                                'group_user.group_id',
                                'group_role.group_id',
                            )
                            .where('project', projectId);
                    })
                    .as('query');
            })
            .count()
            .first();
        return Number(members.count);
    }

    async count(): Promise<number> {
        return this.db
            .from(TABLE)
            .count('*')
            .then((res) => Number(res[0].count));
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    mapLinkRow(row): IEnvironmentProjectLink {
        return {
            environmentName: row.environment_name,
            projectId: row.project_id,
            changeRequestsEnabled: row.change_request_enabled,
        };
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    mapRow(row): IProject {
        if (!row) {
            throw new NotFoundError('No project found');
        }

        return {
            id: row.id,
            name: row.name,
            description: row.description,
            createdAt: row.created_at,
            health: row.health || 100,
            updatedAt: row.updated_at || new Date(),
            changeRequestsEnabled: row.change_request_enabled || false,
        };
    }
}

export default ProjectStore;
