export interface WallBuildQueueComponent {
  /** Ordered list of wall segment site entities to build */
  siteEntities: number[];
  /** Index of the segment currently being built */
  currentIndex: number;
}
