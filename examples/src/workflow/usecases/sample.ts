import {Step, flow} from 'siglo';


const step1 = Step.create('sampleStep', async (param: any) => {
})
const step2 = Step.create('sampleStepWithSpec', async (param: any) => {
})

const step3 = Step.create('sampleStepWithSpecAndValidation', async (param: any) => {
})

const step4 = Step.create('sampleStepWithSpecAndValidation2', async (param: any) => {
})

const step5 = Step.create('sampleStepWithSpecAndValidation4', async (param: any) => {
})

const flow1 = flow(step1, step2, step5);


const flow2 = flow(step3, step4);


const flow3 = flow(flow1, flow2)