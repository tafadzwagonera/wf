import {
  IsString,
  IsOptional,
  IsEnum,
  IsDate,
  IsArray,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum TicketType {
  TASK = 'task',
  BUG = 'bug',
  STORY = 'story',
  TODO = 'todo',
  EPIC = 'epic',
  SUBTASK = 'subtask',
}

/**
 * Normalized priority values used inside wf.
 *
 * These values are intentionally tracker-agnostic. Adapters map them to the
 * exact priority names supported by each external system at runtime.
 */
export enum TicketPriority {
  HIGHEST = 'highest',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  LOWEST = 'lowest',
}

export enum TicketStatus {
  TODO = 'todo',
  IN_PROGRESS = 'in_progress',
  IN_REVIEW = 'in_review',
  DONE = 'done',
  BLOCKED = 'blocked',
  CANCELLED = 'cancelled',
}

/**
 * Universal ticket DTO that serves as the common representation
 * for tickets across all platforms (Jira, GitHub, BitBucket, etc.)
 */
export class UniversalTicket {
  // Core fields
  @IsString()
  title: string;

  @IsString()
  description: string;

  // Metadata
  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsEnum(TicketType)
  type?: TicketType;

  @IsOptional()
  @IsString()
  status?: string;

  /**
   * Normalized priority for cross-tracker workflows.
   *
   * This is not a Jira priority name. Jira, Bitbucket, and GitHub adapters
   * resolve or translate it to a tracker-specific value when needed.
   */
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  // People
  @IsOptional()
  @IsString()
  assignee?: string;

  @IsOptional()
  @IsString()
  reporter?: string;

  // Timestamps
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  created?: Date;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  updated?: Date;

  // Organization
  @IsOptional()
  @IsString()
  project?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  components?: string[];

  // Tracker-specific data (preserved for round-trip conversions)
  @IsOptional()
  @IsObject()
  trackerData?: Record<string, any>;

  constructor(partial?: Partial<UniversalTicket>) {
    if (partial) {
      Object.assign(this, partial);
    }
  }
}

/**
 * Reference to a ticket on a specific platform
 */
export interface IssueTrackerTicketReference {
  tracker: string;
  id: string;
  key?: string;
  url?: string;
}
