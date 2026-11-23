import { Router, Request, Response } from 'express';
import techGovernanceReleasesIntakeService, {
  TechGovernanceRelease,
  TechGovernanceReleaseIntake,
} from '../services/tech-governance-releases-intake.service';
import appDataService from '../services/app-data.service';
import daTeamsService from '../services/da-teams.service';

const router = Router();

/**
 * GET /api/public/tech-governance-releases-intake
 */
router.get('/', async (req: Request, res: Response) => {
    const appSettings = appDataService.getAppSettings();

    const branch = req.query.branch as string | undefined;
    const team = (typeof req.query.team === 'string' ? req.query.team : '').toUpperCase();
    const prAuthor = (typeof req.query.author === 'string' ? req.query.author : '').toLowerCase();
    if (!branch) {
      return res.status(400).json({ error: 'Branch name missing' });
    }
    if (!team) {
      return res.status(400).json({ error: 'Team name missing' });
    }
    if (prAuthor && appSettings.daTeamsTrackerDevNeedsToBeAddedToRaisePR) {
      const prAuthorEmail = prAuthor
        .replace(/_bmogc$/, '')
        .replace(/-/g, '.')
        + '@bmo.com';
      const daTeamsData = daTeamsService.getAll();
      const matchedDaTeamNames = Object.keys(daTeamsData).filter(teamName => {
        const daTeamData = daTeamsData[teamName];
        if (daTeamData.jiraProjects.includes(team)) {
          return true;
        }
      });
      if (!matchedDaTeamNames || !matchedDaTeamNames.length) {
        return res.status(404).json({ error: 'Update DA Teams tracker - https://cdbintake-route-cdb-auto-63623-dv1.ingress.water.ocp4-dv.bmogc.net/da-teams. After updating the tracker, rerun the PR checks.' });
      }
      let developerFound = false;
      for (const matchedDaTeamName of matchedDaTeamNames) {
        const matchedDaTeamData = daTeamsData[matchedDaTeamName];
        if(
          (matchedDaTeamData.devs || []).map(dev => dev.email.toLowerCase()).includes(prAuthorEmail) 
          || (matchedDaTeamData.devLead?.email.toLowerCase() === prAuthorEmail)) {
          developerFound = true;
          break;
        }
      }
      if (!developerFound) {
        return res.status(404).json({ error: 'You are not a developer in this team. Update DA Teams tracker - https://cdbintake-route-cdb-auto-63623-dv1.ingress.water.ocp4-dv.bmogc.net/da-teams. After updating the tracker, rerun the PR checks.' });
      }
    }
    if (!appSettings.daTeamsTrackerTechGovernanceIntakeRequiredToRaisePR) {
      return res.status(200).json({ message: 'TechGovernanceIntake check is disabled' });
    }

    const releaseData = techGovernanceReleasesIntakeService.getByBranch(branch);
    if (!releaseData) {
      return res.status(200).json({ error: 'Platform Release Team should setup this branch for check - ' + branch }); 
    }

    const intakePageId = releaseData.intakePageId;
    let intakes;
    try {
      intakes = await techGovernanceReleasesIntakeService.fetchConfluenceChildPagesDetails(intakePageId);
      if (intakes && intakes.length) {
        intakes = intakes.map(intake => {
          const updatedIntake = releaseData.intakes.find(i => i.id === intake.id);
          if (updatedIntake && typeof updatedIntake.platformVeto === 'number') {
            return { ...intake, platformVeto: updatedIntake.platformVeto };
          }
          return intake;
        })
        releaseData.intakes = intakes;
        techGovernanceReleasesIntakeService.update(branch, releaseData);
      }
    } catch (err) {
    }
    const updatedReleaseData = techGovernanceReleasesIntakeService.getByBranch(branch);
    const teamReleaseIntakes = updatedReleaseData?.intakes.filter(intake => {
      return (intake.jira || '').toUpperCase() === team;
    });
    if (!teamReleaseIntakes || !teamReleaseIntakes.length) {
      return res.status(404).json({ error: `PRs are not allowed until your team creates an intake under page https://bmo.atlassian.net/wiki/spaces/CHNLTECH/pages/${intakePageId} and discusses it within 7 days of creating the intake in Tech Governance Meeting.` });
    }
    const now = new Date();
    const gracePeriod = updatedReleaseData?.gracePeriodInDays;
    const withinXDays = (intake: TechGovernanceReleaseIntake) => {
      if (!gracePeriod || !intake.createdDate) return false;
      // Compare only the date part (ignore time)
      const created = new Date(intake.createdDate);
      const nowDate = new Date();
      const createdDateOnly: Date = new Date(created.getFullYear(), created.getMonth(), created.getDate());
      const nowDateOnly: Date = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
      const diffDays = Math.floor((nowDateOnly.getTime() - createdDateOnly.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays <= gracePeriod;
    };

    let allow = false;
    for (const intake of teamReleaseIntakes) {
      if (intake.platformVeto === 1) {
        return res.status(404).json({ error: 'Your team is not allowed to raise PRs for this release. Check with Platform Release Team.' });
      }
      if (intake.platformVeto === 2 || intake.discussedOn) {
        allow = true;
        break;
      }
      if (withinXDays(intake)) {
        allow = true;
        break;
      }
    }
    if (!allow) {
      return res.status(404).json({ error: `PRs are not allowed until your team discuss intake https://bmo.atlassian.net/wiki/spaces/CHNLTECH/pages/${teamReleaseIntakes[0].id} in Tech Governance Meeting.` });
    }
    return res.json(teamReleaseIntakes[0]);
});

export default router;
