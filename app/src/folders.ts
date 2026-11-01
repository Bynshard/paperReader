import type {Category} from './types';
export type FolderRow=Category&{depth:number;path:string;hasChildren:boolean};
export function folderRows(items:Category[]):FolderRow[]{
  const ids=new Set(items.map(c=>c.id)),children=new Map<string,Category[]>();
  for(const c of items){const key=c.parent_id&&ids.has(c.parent_id)?c.parent_id:'';const group=children.get(key)||[];group.push(c);children.set(key,group);}
  const out:FolderRow[]=[],seen=new Set<string>();
  const visit=(item:Category,depth:number,parent:string)=>{if(seen.has(item.id))return;seen.add(item.id);const path=parent?`${parent} / ${item.name}`:item.name;out.push({...item,depth,path,hasChildren:!!children.get(item.id)?.length});for(const child of children.get(item.id)||[])visit(child,Math.min(depth+1,32),path);};
  for(const root of children.get('')||[])visit(root,0,'');
  for(const item of items)if(!seen.has(item.id))visit(item,0,'');
  return out;
}
export function canParent(items:Category[],candidate:string,id:string){
  if(!id)return true;const parents=new Map(items.map(c=>[c.id,c.parent_id]));const seen=new Set<string>();let current:string|undefined|null=candidate;
  while(current){if(current===id||seen.has(current))return false;seen.add(current);current=parents.get(current);}return true;
}
