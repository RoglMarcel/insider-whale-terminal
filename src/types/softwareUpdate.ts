export interface SoftwareUpdateState {
  status:'idle'|'checking'|'available'|'downloaded'|'current'|'error';
  version:string;
  error?:string;
  checkedAt?:string;
  progress?:number;
}
export type SoftwareUpdateEvent = {type:'checking'} | {type:'current'} | {type:'available'|'downloaded';version:string} | {type:'error';message:string} | {type:'progress';percent:number};
export function reduceSoftwareUpdate(state:SoftwareUpdateState,event:SoftwareUpdateEvent,at=new Date().toISOString()):SoftwareUpdateState {
  if(event.type==='checking')return {...state,status:'checking',error:undefined};
  if(event.type==='current')return {status:'current',version:'',checkedAt:at};
  if(event.type==='error')return {...state,status:'error',error:event.message,checkedAt:at};
  if(event.type==='progress')return {...state,progress:Math.max(0,Math.min(100,event.percent))};
  return {status:event.type,version:event.version,checkedAt:at,progress:event.type==='downloaded'?100:0};
}
