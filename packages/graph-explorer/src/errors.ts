export class GraphExplorerInputError extends TypeError {
  public readonly code = "GRAPH_EXPLORER_INPUT_INVALID" as const;

  public constructor(message: string) {
    super(message);
    this.name = "GraphExplorerInputError";
  }
}
