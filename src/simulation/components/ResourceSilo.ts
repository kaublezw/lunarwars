export type SiloResourceType = 'energy' | 'matter';

export interface ResourceSiloComponent {
  resourceType: SiloResourceType;
  stored: number;
  capacity: number;
  /** Entity ID of the production building that owns this silo (-1 if self or standalone) */
  parentBuilding: number;
}
