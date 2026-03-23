import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { marked } from 'marked';
import {
  Workflow,
  WorkflowMetadata,
  WorkflowInvocation,
  ExecutionStep,
  StepAction,
} from '../../common/interfaces';
import { WorkflowParseError, ValidationError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';

@Injectable()
export class WorkflowParserService {
  private workflowDirectory: string;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    this.workflowDirectory = this.configService.get<string>(
      'workflows.directory',
      '.windsurf/workflows',
    );
  }

  async parseWorkflowFile(filePath: string): Promise<Workflow> {
    this.logger.debug(`Parsing workflow file: ${filePath}`);

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new WorkflowParseError(
        `Failed to read workflow file: ${filePath}`,
        { error, path: filePath },
      );
    }

    try {
      return this.parseWorkflowContent(content, filePath);
    } catch (error) {
      if (
        error instanceof WorkflowParseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new WorkflowParseError(
        `Failed to parse workflow file: ${filePath}`,
        error,
      );
    }
  }

  async findWorkflow(workflowName: string): Promise<Workflow> {
    const workflowPath = path.join(
      this.workflowDirectory,
      `${workflowName}.md`,
    );

    if (!fs.existsSync(workflowPath)) {
      throw new WorkflowParseError(`Workflow not found: ${workflowName}`, {
        searchPath: workflowPath,
      });
    }

    return this.parseWorkflowFile(workflowPath);
  }

  async listWorkflows(): Promise<string[]> {
    const workflowDir = this.workflowDirectory;

    if (!fs.existsSync(workflowDir)) {
      this.logger.warn(`Workflow directory not found: ${workflowDir}`);
      return [];
    }

    const files = fs.readdirSync(workflowDir);
    return files
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace('.md', ''));
  }

  async findWorkflowByName(displayName: string): Promise<Workflow> {
    const workflowFiles = await this.listWorkflows();

    for (const fileName of workflowFiles) {
      try {
        const workflow = await this.findWorkflow(fileName);
        if (workflow.metadata.name === displayName) {
          return workflow;
        }
      } catch (error) {
        this.logger.warn(`Failed to parse workflow: ${fileName}`);
      }
    }

    throw new WorkflowParseError(
      `Workflow not found with name: ${displayName}`,
      { searchName: displayName },
    );
  }

  private parseWorkflowContent(content: string, filePath: string): Workflow {
    const { frontmatter, body } = this.extractFrontmatter(content);

    if (!frontmatter) {
      throw new WorkflowParseError(
        'Workflow file must contain YAML frontmatter',
        { file: filePath },
      );
    }

    const metadata = this.parseMetadata(frontmatter);
    const sections = this.parseMarkdownSections(body);

    const invocation = this.parseInvocation(sections);
    const steps = this.parseExecutionSteps(sections);
    const evaluationCriteria = this.parseEvaluationCriteria(sections);

    const workflow: Workflow = {
      metadata,
      invocation,
      steps,
      evaluationCriteria,
    };

    this.validateWorkflow(workflow);

    return workflow;
  }

  private extractFrontmatter(content: string): {
    frontmatter: any;
    body: string;
  } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return { frontmatter: null, body: content };
    }

    try {
      const frontmatter = yaml.parse(match[1]);
      const body = match[2];
      return { frontmatter, body };
    } catch (error) {
      throw new WorkflowParseError('Invalid YAML frontmatter', error);
    }
  }

  private parseMetadata(frontmatter: any): WorkflowMetadata {
    return {
      name: frontmatter.name || 'Unnamed Workflow',
      description: frontmatter.description || '',
      autoExecutionMode: frontmatter.autoExecutionMode !== false,
      version: frontmatter.version,
      tags: frontmatter.tags || [],
    };
  }

  private parseMarkdownSections(markdown: string): Map<string, string> {
    const sections = new Map<string, string>();
    const lines = markdown.split('\n');
    let currentSection = '';
    let currentContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^#{1,2}\s+(.+)$/);

      if (headerMatch) {
        if (currentSection) {
          sections.set(currentSection, currentContent.join('\n').trim());
        }
        currentSection = headerMatch[1].trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections.set(currentSection, currentContent.join('\n').trim());
    }

    return sections;
  }

  private parseInvocation(sections: Map<string, string>): WorkflowInvocation {
    const invocationText =
      sections.get('Invocation') || sections.get('Usage') || '';

    // Extract command and parameters from invocation section
    const commandMatch = invocationText.match(/`([^`]+)`/);
    const command = commandMatch ? commandMatch[1] : '';

    return {
      command,
      parameters: [],
      examples: this.extractCodeBlocks(invocationText),
    };
  }

  private parseExecutionSteps(sections: Map<string, string>): ExecutionStep[] {
    const stepsText =
      sections.get('Execution Steps') ||
      sections.get('Steps') ||
      sections.get('Workflow') ||
      '';

    const steps: ExecutionStep[] = [];
    const stepMatches = stepsText.matchAll(/^(?:#{3,4}|\d+\.)\s+(.+)$/gm);

    let order = 1;
    for (const match of stepMatches) {
      const title = match[1].trim();
      const stepId = this.generateStepId(title);

      // Check if this step requires approval
      const requiresApproval = this.checkRequiresApproval(title, stepsText);

      steps.push({
        id: stepId,
        title,
        order: order++,
        instructions: [],
        actions: [],
        requiresApproval,
        retryable: true,
      });
    }

    return steps;
  }

  private parseEvaluationCriteria(sections: Map<string, string>): string[] {
    const criteriaText =
      sections.get('Evaluation Criteria') ||
      sections.get('Success Criteria') ||
      '';

    const criteria: string[] = [];
    const lines = criteriaText.split('\n');

    for (const line of lines) {
      const match = line.match(/^[-*]\s+(.+)$/);
      if (match) {
        criteria.push(match[1].trim());
      }
    }

    return criteria;
  }

  private checkRequiresApproval(title: string, context: string): boolean {
    const approvalKeywords = [
      'wait for',
      'approval',
      'user confirmation',
      'review',
      'confirm',
      'verify',
    ];

    const titleLower = title.toLowerCase();
    return approvalKeywords.some((keyword) => titleLower.includes(keyword));
  }

  private generateStepId(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private extractCodeBlocks(text: string): string[] {
    const codeBlockRegex = /```[\s\S]*?```/g;
    const matches = text.match(codeBlockRegex);
    return matches
      ? matches.map((block) => block.replace(/```/g, '').trim())
      : [];
  }

  private validateWorkflow(workflow: Workflow): void {
    if (!workflow.metadata.name) {
      throw new ValidationError('Workflow must have a name');
    }

    if (workflow.steps.length === 0) {
      throw new ValidationError(
        'Workflow must have at least one execution step',
      );
    }

    // Validate step IDs are unique
    const stepIds = new Set<string>();
    for (const step of workflow.steps) {
      if (stepIds.has(step.id)) {
        throw new ValidationError(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);
    }
  }
}
