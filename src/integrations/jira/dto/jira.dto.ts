export interface CreateTicketRequest {
  project: string;
  summary: string;
  description: string;
  issueType: string;
  priority?: string;
  labels?: string[];
  assignee?: string;
  components?: string[];
}

export interface JiraTicket {
  key: string;
  id: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority: string;
  assignee?: string;
  reporter?: string;
  created: Date;
  updated: Date;
  labels: string[];
  components: string[];
}

export interface UpdateTicketRequest {
  summary?: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string;
}

export interface JiraSearchRequest {
  jql: string;
  maxResults?: number;
  fields?: string[];
}
