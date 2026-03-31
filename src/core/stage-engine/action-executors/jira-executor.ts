import { Injectable } from '@nestjs/common';
import { BaseExecutor } from './base-executor';
import {
  StageContext,
  StageResult,
  Artifact,
} from '../../../common/interfaces';
import { JiraService } from '../../../integrations/jira/jira.service';
import {
  CreateTicketRequest,
  UpdateTicketRequest,
} from '../../../integrations/jira/dto/jira.dto';
import { LoggerService } from '../../../shared/logger/logger.service';

export interface JiraActionConfig {
  operation: 'create' | 'get' | 'update' | 'search';
  ticketKey?: string;
  createRequest?: CreateTicketRequest;
  updateRequest?: UpdateTicketRequest;
  jql?: string;
}

@Injectable()
export class JiraExecutor extends BaseExecutor {
  constructor(
    private jiraService: JiraService,
    private logger: LoggerService,
  ) {
    super();
  }

  async execute(
    action: JiraActionConfig,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    void context;
    const { operation } = action;

    this.logger.debug(`Executing Jira action: ${operation}`);

    try {
      const startTime = Date.now();
      let result: any;
      const artifacts: Artifact[] = [];

      switch (operation) {
        case 'create':
          if (!action.createRequest) {
            throw new Error('Create operation requires createRequest');
          }
          result = await this.jiraService.createTicket(action.createRequest);
          artifacts.push({
            type: 'text',
            name: 'Created Ticket Key',
            content: result,
          });
          break;

        case 'get':
          if (!action.ticketKey) {
            throw new Error('Get operation requires ticketKey');
          }
          result = await this.jiraService.getTicket(action.ticketKey);
          artifacts.push({
            type: 'json',
            name: 'Ticket Details',
            content: JSON.stringify(result, null, 2),
          });
          break;

        case 'update':
          if (!action.ticketKey || !action.updateRequest) {
            throw new Error(
              'Update operation requires ticketKey and updateRequest',
            );
          }
          await this.jiraService.updateTicket(
            action.ticketKey,
            action.updateRequest,
          );
          result = { ticketKey: action.ticketKey, updated: true };
          break;

        case 'search':
          if (!action.jql) {
            throw new Error('Search operation requires jql');
          }
          result = await this.jiraService.searchTickets({ jql: action.jql });
          artifacts.push({
            type: 'json',
            name: 'Search Results',
            content: JSON.stringify(result, null, 2),
          });
          break;

        default:
          throw new Error(`Unknown Jira operation: ${operation}`);
      }

      const duration = Date.now() - startTime;

      this.logger.success(`Jira ${operation} completed in ${duration}ms`);

      return {
        ...this.createSuccessResult({ jiraResult: result }),
        artifacts,
        duration,
      };
    } catch (error: any) {
      this.logger.error(`Jira action failed: ${error.message}`);
      return this.createFailureResult(error, 'JIRA_EXECUTION_ERROR');
    }
  }
}
