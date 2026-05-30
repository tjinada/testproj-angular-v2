import artifactoryService from './artifactory.service';
import cacheSyncService from './cache-sync.service';
import { DATeam, DATeamsData } from '../models';

export const daTeamRequiredFields = [
	'name',
	'jiraProjects',
	'dm',
	'adm',
	'devLead',
	'prApprovers',
	'qaLead',
	'features',
] as const;

export const daTeamKeys: readonly (keyof DATeam)[] = [
  'name',
  'jiraProjects',
  'dm',
  'qm',
  'adm',
  'bd',
  'po',
  'sto',
  'ba',
  'sa',
  'dpm',
  'devops',
  'devs',
  'devLead',
  'prApprovers',
  'devsPoland',
  'qas',
  'qaLead',
  'features',
  'details',
] as const;

export type DATeamRequiredField = typeof daTeamRequiredFields[number];

class DATeamsService {
	private readonly dataFilePath = 'da_teams_data.json';

	daTeams: DATeamsData = {};

	constructor() {
		this.initialize();
		cacheSyncService.register('da-teams', () => this.initialize());
	}

	async initialize(): Promise<void> {
		try {
			const data = await artifactoryService.getFileContent(this.dataFilePath);
			this.daTeams = { ...data };
		} catch (error) {
			console.log('No existing DA teams data found in artifactory');
		}
	}

	private async save(): Promise<void> {
		await artifactoryService.saveFileContent(this.dataFilePath, this.daTeams);
		cacheSyncService.notifyPeers('da-teams');
		// Set PR approvers
      try {
        const prApprovers: Record<string, { reviewers: string[]; devsPoland: string[] }> = {
          Generic: { reviewers: [], devsPoland: [] },
        };
        
        // First pass: collect all approvers as arrays
        Object.values(this.daTeams).forEach(team => {
          const approvers = team.prApprovers.map(dev => dev.email.replace('@bmo.com', '_bmogc').replaceAll('.', '-'));
          const devsFromPoland = team.devsPoland?.map(dev => dev.email.replace('@bmo.com', '_bmogc').replaceAll('.', '-')) || [];
          
          team.jiraProjects.forEach(jiraProject => {
            if (!prApprovers[jiraProject]) {
              prApprovers[jiraProject] = {
                reviewers: [],
                devsPoland: [],
              };
            }
            // Append to existing arrays
            prApprovers[jiraProject].reviewers.push(...approvers);
            prApprovers[jiraProject].devsPoland.push(...devsFromPoland);
          });
        });
        
        // Second pass: convert arrays to comma-separated strings
		const updatedPrApprovers: Record<string, { reviewers: string; devsPoland: string }> = {};
        Object.keys(prApprovers).forEach(jiraProject => {
			updatedPrApprovers[jiraProject] = {
				reviewers: prApprovers[jiraProject].reviewers.join(','),
				devsPoland: prApprovers[jiraProject].devsPoland.join(','),
			}; 
        });
        await artifactoryService.saveFileContent('/pr_approver.json', updatedPrApprovers);
      } catch (error) {
        console.log(error);
      }

      try {
        const devTeamMap = Object.values(this.daTeams).reduce((acc: any, team) => {
            [...(team.devs || []), team.devLead].forEach((dev) => {
                const githubHandler = dev.email.replace('@bmo.com', '_bmogc').replaceAll('.', '-')
                if (!acc[githubHandler]) {
                acc[githubHandler] = [];
                }
                acc[githubHandler].push({
                  ...dev,
                  jiraProjects: team.jiraProjects,
                  teamName: team.name
                });
            });
            return acc;
        } , {});
		await artifactoryService.saveFileContent('/devlopers_team_mapping.json', devTeamMap);
      } catch (error) {
        console.log(error);
      }
	}

	/**
	 * Returns cached DA teams data.
	 */
	getAll(): DATeamsData {
		return this.daTeams;
	}

	/**
	 * Adds a DA team entry. Throws if key already exists.
	 */
	async add(key: string, team: DATeam): Promise<DATeam> {
		if (!key || typeof key !== 'string') {
			throw new Error('Team key is required');
		}

		if (this.daTeams[key]) {
			throw new Error(`DA team '${key}' already exists`);
		}

        const filteredTeamData = this.getFilteredDATeamData(team);

		this.daTeams[key] = filteredTeamData as DATeam;
		await this.save();
		return filteredTeamData as DATeam;
	}

	/**
	 * Replaces an existing DA team entry. Throws if key does not exist.
	 */
	async update(key: string, team: DATeam): Promise<DATeam> {
		if (!this.daTeams[key]) {
			throw new Error(`DA team '${key}' not found`);
		}

        const filteredTeamData = this.getFilteredDATeamData(team);

        if (key !== team.name) {
          // If the team name has changed, we need to delete the old entry and create a new one
          delete this.daTeams[key];
        }

		this.daTeams[team.name] = filteredTeamData as DATeam;
		await this.save();
		return filteredTeamData as DATeam;
	}

    getFilteredDATeamData(teamData: DATeam): DATeam {
        const filteredData: Partial<DATeam> = {};

        daTeamKeys.forEach((key) => {
            if (key in teamData) {
                filteredData[key] = teamData[key as keyof DATeam] as any;
            }
        });
        if (filteredData.devs && filteredData.devLead) {
            filteredData.devs = filteredData.devs.filter(dev => dev.email !== filteredData.devLead?.email);
        }
        if (filteredData.qas && filteredData.qaLead) {
            filteredData.qas = filteredData.qas.filter(qa => qa.email !== filteredData.qaLead?.email);
        }
        (['devs', 'qas', 'prApprovers', 'devsPoland', 'devops'] as (keyof DATeam)[]).forEach((field) => {
            if ((filteredData[field] as any)?.length) {
            filteredData[field] = (filteredData[field] as any).sort((p1: any, p2: any) => p1.name < p2.name ? -1 : 0);
            }
        });
        filteredData.v = 1;
        filteredData.lastUpdated = {
            by: 'System',
            at: new Date().toUTCString()
        }

        return filteredData as DATeam;
    }

	/**
	 * Deletes a DA team entry. Returns true if deleted, false otherwise.
	 */
	async delete(key: string): Promise<boolean> {
		if (!this.daTeams[key]) {
			return false;
		}

		delete this.daTeams[key];
		await this.save();
		return true;
	}
}

export default new DATeamsService();
