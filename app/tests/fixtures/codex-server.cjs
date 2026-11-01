#!/usr/bin/env node
const readline=require('node:readline');
let signed=false,turn=0,thread=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const note=(method,params)=>send({method,params});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.method||m.id===undefined)return;
  const p=m.params||{};let r={};
  switch(m.method){
    case 'initialize':r={userAgent:'fixture'};break;
    case 'account/read':r={account:signed?{type:'chatgpt',email:'fixture@example.test',planType:'plus'}:null};break;
    case 'account/login/start':
      r={type:'chatgpt',loginId:'login-1',authUrl:'https://auth.openai.com/authorize?state=fixture'};
      setTimeout(()=>{signed=true;note('account/login/completed',{loginId:'login-1',success:true});},20);break;
    case 'account/logout':signed=false;break;
    case 'model/list':r={data:[{model:'fixture-model',displayName:'Fixture',isDefault:true}],nextCursor:null};break;
    case 'account/rateLimits/read':r={rateLimits:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1800000000}}};break;
    case 'thread/start':r={thread:{id:`thread-${++thread}`},model:'fixture-model'};break;
    case 'turn/start':{
      const id=`turn-${++turn}`,threadId=p.threadId;
      r={turn:{id,status:'inProgress'}};
      note('turn/started',{threadId,turn:r.turn});
      if(p.input[0].text.includes('CRASH'))process.exit(2);
      if(!p.input[0].text.includes('WAIT')){
        note('item/agentMessage/delta',{threadId,turnId:id,itemId:'answer',delta:'中文'});
        note('item/agentMessage/delta',{threadId,turnId:id,itemId:'answer',delta:'回答 [1]'});
        note('item/completed',{threadId,turnId:id,item:{type:'agentMessage',id:'answer',text:'中文回答 [1]',phase:'final_answer'}});
        note('turn/completed',{threadId,turn:{id,status:'completed'}});
      }break;
    }
    case 'turn/interrupt':note('turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}});break;
  }
  send({id:m.id,result:r});
});
