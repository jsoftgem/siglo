import {
    flow,
    isFlow,
    isPipeline,
    pipe,
    Step,
    toPOJO as stepToPOJO,
    parallel,
    branch,
    wait,
    map,
    toMermaid,
    toJSON,
    toDot
} from "../../index";
import {
    addChainToStack,
    clearStorage,
    createExecutionStack,
    defaultStorageManager,
    getChainContext,
    putChainContext,
    setPutChainContextPlugin,
    StorageManager
} from "../storage";
import {expect} from "chai";
import {FlowContextResult} from "./index";

describe("Step unit test", () => {
    it("should execute multi-step pipeline with direct step instances", done => {
        const s0 = Step.create("sample_connect_0", ({value}) => value + 1);
        const s2 = Step.create("sample_connect_2", ({value}) => value + 2);
        const s3 = Step.create("sample_connect_3", ({value}) => value + 3);

        const connectEverything = Step.create("connectEverything", ({sum}) => sum);

        flow(connectEverything, s0, s2, s3)
            .execute({sum: 1})
            .then((value) => {
                expect(value).to.be.equal(7);
                done();
            }).catch(err => {
            console.log("error", err);
            done();
        });
    });

    it("should get default spec throughout the steps", done => {
        const step1 = Step.create("_thr_step_0_1", (param) => {
            expect(param.port).to.be.not.undefined;
            expect(param.port).to.be.equal(1000);
        })
            .spec("port", {default: 1000});

        const step2 = Step.create("_thr_step_0_2", param => {
            expect(param.sample_port).to.be.not.undefined;
            expect(param.sample_port).to.be.equal(2000);
        })
            .spec("sample_port", {default: 2000});

        Step.start([step1, step2]).then(() => {
            done();
        }).catch(error => {
            console.error(error);
        });
    });
    it("should be able to get root paramaters throuhgout the chains", done => {
        const s1 = Step.create("_thru_step1", (params) => {
            expect(params.config).to.be.not.undefined;
            expect(params.config).to.be.equal("hello");
            expect(params.ignoreMe).to.be.not.undefined;
            expect(params.ignoreMe).to.be.equal("ignored");
        }).spec("config", {require: true, default: "defaultConfig"});
        const s2 = Step.create("_thru_step2", (params) => {
            expect(params.ignoreMe).to.be.undefined;
            expect(params.config).to.be.equal("hello");
            expect(params.config).to.be.not.undefined;
        }).strict().spec("config", {require: true});
        const s3 = Step.create("_thru_step3", (params) => {
            expect(params.ignoreMe).to.be.undefined;
            expect(params.config).to.be.equal("hello");
            expect(params.config).to.be.not.undefined;
        }).strict().spec("config", {require: true});
        const s4 = Step.create("_thru_step4", (params) => {
            expect(params.newValue).to.be.not.undefined;
            expect(params.config).to.be.not.undefined;
            expect(params.config).to.be.equal("hello");
            expect(params.ignoreMe).to.be.not.undefined;
            expect(params.ignoreMe).to.be.equal("ignored");
        }).spec("config", {
            require: true,
            translate: (value: any, context: {
                set: (arg0: string, arg1: any) => void;
            }) => new Promise<void>((resolve) => {
                context.set("newValue", value);
                resolve();
            })
        });
        const s5 = Step.create("_thru_step5", (params) => {
            expect(params.config).to.be.not.undefined;
            expect(params.config).to.be.equal("hi");
            expect(params.ignoreMe).to.be.not.undefined;
            expect(params.ignoreMe).to.be.equal("ignored");
        }).spec("config", {
            require: true, transform: () => new Promise((resolve) => {
                resolve("hi");
            })
        });

        Step.start([s1, s2, s3, s4, s5], {
            config: "hello",
            ignoreMe: "ignored"
        }).then((result) => {
            console.log('result', result);
            done();
        }).catch(err => {
            console.error(err)
        });
    });
    it("should run after plugin", done => {
        Step.config({
            plugins: [
                {
                    name: "Sample1",
                    action: () => {
                        return {something: "nice"};
                    },
                    after: ["stepBefore2"]
                }
            ]
        });
        const c2 = Step.create("stepBefore2", (context) => {
            expect(context.Sample1).to.be.undefined;
        });
        const c3 = Step.create("stepBefore3", (context) => {
            expect(context.Sample1).to.be.not.undefined;
            expect(context.Sample1.something).to.be.equal("nice");
        });
        flow(c2, c3).execute({main: "lo"}).then(() => {
            done();
        }).catch(err => {
            console.error(err);
        });
    });
    it("should run before plugin", done => {
        Step.config({
            plugins: [
                {
                    name: "Sample1",
                    action: () => {
                        return {something: "nice"};
                    },
                    before: ["stepBefore1"]
                }
            ]
        });
        Step.create("stepBefore1", (context) => {
            expect(context.Sample1).to.be.not.undefined;
            expect(context.Sample1.something).to.be.equal("nice");
        }).execute({main: "lo"}).then(() => {
            done();
        }).catch(err => {
            console.error(err)
        });
    });
    it("should not be allowed to start if name is undefined", () => {
        expect(Step.start(undefined)).to.be.undefined;
    });
    it("should allow function w/out parameter in spec.require", done => {
        function innerClass() {
            let sampleClass: any = {};
            sampleClass.innerHello = "Hi";
            sampleClass.isRequired = function () {
                return sampleClass.innerHello === "Hi";
            }
            const s = new Step("RequireSampleStep", (param) => {

            }).spec("sample", {
                require: sampleClass.isRequired
            });
            return {sampleClass, s};
        }

        let inner = innerClass();

        inner.sampleClass.innerHello = "hello";
        const s1 = new Step("RequireSampleStep1", () => {
        });
        Step.start([s1, inner.s])
            .then((result) => {
                done();
            })
            .catch(error => {
                expect(error.error.message).to.be.equal("Field sample is required.");
                done();
            });
    });
    it("get the field specified in result function", () => {
        const step = new Step("FieldStepSample1", (parameters) => {
            const hello = parameters.takeThat.hello;
            expect(hello).to.be.equal("hello");
            return {
                takeThis: {
                    hello
                }
            };
        });
        Step.start(step, {
            takeThat: {
                hello: "hello"
            }
        }).then(result => {
            expect(result.takeThis.hello).to.be.equal("hello");
        }).catch(error => {
            console.error(error);
        });
    });
    it("executes step", done => {
        const step = new Step("SampleStep1", (parameter) => {
            let context: any = {};
            context.hello = "world!";
            context.fromParam = parameter.hi;
            return context;
        });

        Step.start(step, {hi: "initParam"})
            .then(result => {
                expect(result.hello).to.be.equal("world!");
                expect(result.fromParam).to.be.equal("initParam");
                done();
            })
            .catch(err => {
                console.log(err);
                done();
            });
    });
    it("checks if step name is stored properly", () => {
        const step = new Step("ExistingStep", () => {
        });
        expect(step.name).to.equal("ExistingStep");
    });
    it("executes step asynchronously", done => {
        const step = new Step("SampleStep2", (parameter) => {
            let context: any = {};
            context.hello = "world!";
            context.fromParam = parameter.hi;
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(context);
                });
            });
        });

        Step.start(step, {hi: "initParam"})
            .then(result => {
                expect(result.hello).to.be.equal("world!");
                expect(result.fromParam).to.be.equal("initParam");
                done();
            })
            .catch(err => {
                console.log(err);
                done();
            });
    });

    it("executes step that return string literals", done => {
        const step = new Step("SampleStep3", (parameter) => {
            return "hello";
        });
        Step.start(step)
            .then(result => {
                expect(result.value).to.be.not.undefined;
                expect(result.value).to.be.equal("hello");
                done();
            });
    });

    it("executes multiple steps", done => {
        const s4 = new Step("SampleStep4", (parameter) => {
            return {
                _1st: "1st"
            };
        });
        const s5 = new Step("SampleStep5", (parameter) => {
            return parameter._1st + " - 2nd";
        });
        const s6 = new Step("SampleStep6", (parameter) => {
            return {
                _3rd: parameter.value + " - 3rd"
            };
        });

        Step.start([s4, s5, s6])
            .then(result => {
                expect(result._3rd).to.be.equal("1st - 2nd - 3rd");
                done();
            }).catch(() => {
            done();
        });
    });

    it("executes step with reducer", done => {
        const step = new Step("SampleStepReducer", (parameter, current) => {
            return current + (parameter.value ? parameter.value : 0);
        }).reduce("sampleArray");

        Step.start(step, {sampleArray: [1, 2, 3, 4, 5]})
            .then(result => {
                expect(result.value).to.be.equal(15);
                done();
            })
            .catch(err => console.log);
    });

    it("executes multiple steps with reducer", done => {
        const sRed = new Step("SampleStepReducer1", (parameter, current) => {
            return current + (parameter.value ? parameter.value : 0);
        }).reduce("sampleArray");
        const s7 = new Step("SampleStep7", (parameter) => {
            return {sum: 5 + parameter.value};
        });
        Step.start([sRed, s7], {sampleArray: [1, 2, 3, 4, 5]})
            .then(result => {
                expect(result.sum).to.be.equal(20);
                done();
            })
            .catch(err => {
                console.log(err);
                done();
            });
    });

    it("should executes step with strict mode on", done => {
        const step = new Step("SampleStep8", (parameter) => {
            expect(parameter.sample).to.be.not.undefined;
            expect(parameter.hello).to.be.undefined;
        }).spec("sample", {
            require: true
        }).strict();
        Step.start(step, {
            sample: "sample",
            hello: "hello"
        }).then(() => {
            done();
        }).catch(err => {
            console.log(err);
            done();
        });
    });

    it("should executes step with transform spec", done => {
        const step = new Step("SampleStep9", (parameter) => {
            expect(parameter.sample).to.be.equal("hello");
        }).spec("sample", {
            transform: () => {
                return new Promise((resolve) => {
                    resolve("hello");
                });
            }
        });
        Step.start(step, {
            sample: "sample"
        }).then(() => {
            done();
        }).catch(err => {
            console.log(err);
            done();
        });
    });

    it("should execute chain with translate spec", done => {
        const step = new Step("SampleStep10", (parameter) => {
            expect(parameter.something).to.be.equal("sweet");
        }).spec("sample", {
            translate: (value: any, context: any) => {
                return new Promise((resolve: any) => {
                    expect(value).to.be.equal("sample");
                    context.set("something", "sweet");
                    resolve();
                });
            }
        });
        Step.start(step, {
            sample: "sample"
        }).then(() => {
            done();
        }).catch(err => {
            console.log(err);
            done();
        });
    });

    it("should executes step with custom validator", done => {
        const s11 = new Step("SampleStep11", (parameter) => {
            expect(parameter.sample).to.be.equal("sample");
        }).spec("sample", {
            validate: (value: string) => {
                return new Promise((resolve) => {
                    resolve(value === "sample");
                });
            }
        });
        Step.start(s11, {
            sample: "sample"
        });

        const s12 = new Step("SampleStep12", (parameter) => {
            expect(parameter.sample).to.be.undefined;
        }).spec("sample", {
            validate: (value: string) => {
                return new Promise((resolve, reject) => {
                    if (value !== "sample") {
                        reject(new Error("Value should be sample"));
                    }
                });
            }
        }).spec("sample2", {require: true});
        Step.start(s12, {value: "false"}).catch(status => {
            expect(status.error.length).to.be.equal(2);
            expect(status.error[0].field).to.be.equal("sample");
            expect(status.error[0].error.message).to.be.equal("Value should be sample");
            expect(status.error[1].field).to.be.equal("sample2");
            expect(status.error[1].error.message).to.be.equal("Field sample2 is required.");
            done();
        });
    });
    it("should handle require as function", done => {
        const reqStep = new Step("RequireTestStep", () => {

        }).spec("sample1", {
            require: true
        });

        Step.start(reqStep)
            .catch(stack => {
                console.log("stack.error.func", stack.error.func);
                expect(stack.error[0].field).to.be.equal("sample1");
                expect(stack.error.func).to.be.equal("RequireTestStep");
            });

        const reqStep2 = new Step("RequireTestStep2", () => {

        }).spec("sample2", {
            require: () => false
        });
        Step.start(reqStep2)
            .then(() => {
                done();
            })
            .catch(stack => {
                console.log("statc", stack);
            });
    });
    it("should execute step action defined via Step.create with onBefore validation", done => {
        let ifIStarted = false;
        const c13 = Step
            .create("SampleStep13", (param) => {
                return {
                    status: "I ran"
                };
            })
            .onBefore((param) => {
                ifIStarted = true;
                return true;
            });
        const c14 = Step
            .create("SampleStep14", () => "I ran 14")
            .onBefore(() => {
                ifIStarted = false;
                return false;
            });
        flow(c13, c14)
            .execute()
            .then((result) => {
                expect(ifIStarted).to.be.false;
                done();
            }).catch(err => {
            console.log(err);
            done();
        });
    });

    it("should trigger onFail function is a chain has failed", done => {
        Step.create("SampleStep15", () => {
            throw new Error("I failed");
        })
            .onFail((error, retry, reject) => {
                expect(error.message).to.be.equal("I failed");
                reject();
            })
            .execute()
            .catch(err => {
                done();
            });
    });
    it("should retry when chain has failed", done => {
        let retried = false;
        Step.create("SampleStep16", () => {
            if (!retried) {
                throw new Error("I failed");
            } else {
                return "done";
            }
        })
            .onFail((error, retry) => {
                retried = true;
                console.log("retried", retried);
                retry();
            })
            .execute()
            .then(({value}: any) => {
                expect(value).to.be.equal("done");
                done();
            }).catch(err => console.log);
    });

    it("should cache chain action", done => {
        let counter = 0;
        const s17 = Step.create("SampleStep17", () => {
            counter++;
            return "17";
        })
            .spec("hello")
            .strict()
            .cache();

        const s18 = Step.create("SampleStep18", () => {
            counter++;
            return "18";
        })
            .spec("hello")
            .strict()
            .cache(5000);

        Step.start([s17, s18, s17, s18], {
            hello: "hello"
        }).then(result => {
            expect(counter).to.be.equal(2);
            done();
        }).catch(console.log);
    });

    it("should cache chain action for a specific time", done => {
        let counter = 0;
        const s19 = Step.create("SampleStep19", () => {
            counter++;
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    resolve("19");
                }, 501);
            })
        })
            .spec("hello")
            .strict();

        const s20 = Step.create("SampleStep20", () => {
            counter++;
            return "18";
        })
            .spec("hello")
            .strict()
            .cache(500);

        Step.start([s19, s20, s19, s20], {
            hello: "hello"
        }).then(result => {
            expect(counter).to.be.equal(4);
            done();
        }).catch(console.log);
    });

    it("initializes chain sequence and default instance correctly", () => {
        const s1 = new Step("s1");
        const s2 = new Step("s2");
        const customSeq = new Step("customSeq", () => {
        }, [s1, s2]);
        expect(customSeq.sequence).to.deep.equal([s1, s2]);

        const singleStep = Step.create("singleSeq");
        expect(singleStep.sequence).to.deep.equal([singleStep]);
    });

    it("supports spec with all json options", () => {
        const c = Step.create("fullSpecStep")
            .spec("fullField", {
                require: true,
                requireMessage: "Custom required",
                default: "defValue",
                validate: (v: any) => Promise.resolve(v),
                transform: (v: any) => Promise.resolve(v),
                translate: (v: any, ctx: any) => Promise.resolve(ctx)
            })
            .cache();
        expect(c.specs.length).to.equal(1);
        expect(c.cachedLast).to.equal(1500);
    });
    it("supports default action and Step.config", async () => {
        Step.config({});
        const defaultStep = new Step("defaultActionStep");
        const res = await defaultStep.execute({});
        expect(res).to.be.an("object");
    });
    it("supports anonymous step created with action function", async () => {
        const anonymous = new Step((param: any) => ({hello: "world"}));
        expect(anonymous.name).to.equal("");
        const res = await anonymous.execute({});
        expect(res.hello).to.equal("world");
    });

    it("supports Step.create with action function", async () => {
        const anonymous = Step.create((param: any) => ({ans: 42}));
        const res = await anonymous.execute({});
        expect(res.ans).to.equal(42);
    });

    it("supports Step.start with direct chain instances and array of chain instances", async () => {
        const step1 = Step.create((param: any) => ({count: (param.count || 0) + 1}));
        const step2 = Step.create((param: any) => ({count: param.count * 10}));

        const singleRes = await Step.start(step1, {count: 5});
        expect(singleRes.count).to.equal(6);

        const arrayRes = await Step.start([step1, step2], {count: 2});
        expect(arrayRes.count).to.equal(30);
    });

    it("supports composing steps with direct Step instances in pipe", async () => {
        const step1 = Step.create((param: any) => ({first: "step1"}));
        const step2 = Step.create((param: any) => ({second: param.first + "-step2"}));
        const pipeline = flow(step1, step2);
        const res: any = await pipeline.execute();
        expect(res.second).to.equal("step1-step2");
    });

    it("supports pipe with spread arguments and array", async () => {
        const step1 = Step.create((param: any) => ({val: 10}));
        const step2 = Step.create((param: any) => ({val: param.val + 5}));

        const pipeline1 = flow(step1, step2);
        const res1 = await pipeline1.execute();
        expect(res1.val).to.equal(15);

        const pipeline2 = flow([step1, step2]);
        const res2 = await pipeline2.start();
        expect(res2.val).to.equal(15);

        const pStep1 = Step.create((param: any) => ({val: 10}));
        const pStep2 = Step.create((param: any) => ({val: param.val + 5}));
        const res3 = await Step.flow(pStep1, pStep2).execute();
        expect(res3.val).to.equal(15);
    });

    it("supports caching on direct chain instance without name", async () => {
        let runCount = 0;
        const cachedStep = Step.create(() => {
            runCount++;
            return {executed: true};
        }).strict().cache(1000);

        await Step.start([cachedStep, cachedStep], {});
        expect(runCount).to.equal(1);
    });

    it("supports pipeline .run() and chain .run()", async () => {
        const step1 = Step.create((param: any) => ({a: 10}));
        const step2 = Step.create((param: any) => ({b: param.a + 20}));

        const pipeline = flow(step1, step2);
        const resPipeline = await pipeline.run({});
        expect(resPipeline.b).to.equal(30);

        const singleStep = Step.create((param: any) => ({x: 42}));
        const resSingle = await singleStep.run({});
        expect(resSingle.x).to.equal(42);
    });

    it("supports clean POJO parameter access on params", async () => {
        let capturedVal: any;
        let capturedCoercedNumber: any;
        let capturedInterpolation: any;
        let capturedNested: any;

        const chain = Step.create((param: any) => {
            capturedVal = param.count;
            capturedCoercedNumber = +param.count;
            capturedInterpolation = `${param.greeting}`;
            capturedNested = param.user.name;
            return {
                result: param.count * 2
            };
        });

        const res = await chain.execute({
            count: 7,
            greeting: "hello",
            user: {name: "Bob"}
        });

        expect(capturedVal).to.equal(7);
        expect(capturedCoercedNumber).to.equal(7);
        expect(capturedInterpolation).to.equal("hello");
        expect(capturedNested).to.equal("Bob");
        expect(res.result).to.equal(14);
    });

    it("supports chain for native object destructuring", async () => {
        const modernStep = Step.create(async ({a, b}: any) => {
            return {sum: a + b};
        });

        const res = await modernStep.execute({a: 15, b: 25});
        expect(res.sum).to.equal(40);
        expect(res.sum).to.equal(40);
        expect(res.sum).to.equal(40);
    });

    it("supports structured onFail with fixed backoff and delay 0", async () => {
        let attempts = 0;
        const retryStep = Step.create(() => {
            attempts++;
            if (attempts < 3) {
                throw new Error(`Attempt ${attempts} failed`);
            }
            return {done: true};
        }).onFail({
            maxRetries: 3,
            backoff: "fixed",
            delay: 0
        });

        const res = await retryStep.execute({});
        expect(attempts).to.equal(3);
        expect(res.done).to.be.true;
    });

    it("supports structured onFail with exponential backoff, jitter, and onRetry callback", async () => {
        let attempts = 0;
        const retryLogs: number[] = [];

        const expStep = Step.create(() => {
            attempts++;
            if (attempts < 3) {
                throw new Error("fail");
            }
            return {success: true};
        }).onFail({
            maxRetries: 3,
            backoff: "exponential",
            delay: 2,
            maxDelay: 3,
            jitter: true,
            onRetry: (_err, attempt) => {
                retryLogs.push(attempt);
            }
        });

        const res = await expStep.execute({});
        expect(attempts).to.equal(3);
        expect(retryLogs).to.deep.equal([1, 2]);
        expect(res.success).to.be.true;
    });

    it("supports structured onFail with linear backoff and custom backoff function", async () => {
        let linearAttempts = 0;
        const linearStep = Step.create(() => {
            linearAttempts++;
            if (linearAttempts < 2) {
                throw new Error("linear fail");
            }
            return {ok: true};
        }).onFail({
            maxRetries: 2,
            backoff: "linear",
            delay: 2
        });
        const resLinear = await linearStep.execute({});
        expect(linearAttempts).to.equal(2);
        expect(resLinear.ok).to.be.true;

        let customAttempts = 0;
        const customStep = Step.create(() => {
            customAttempts++;
            if (customAttempts < 2) {
                throw new Error("custom fail");
            }
            return {customOk: true};
        }).onFail({
            maxRetries: 2,
            backoff: (attempt) => attempt * 2,
            delay: 1
        });
        const resCustom: any = await customStep.execute({});
        expect(customAttempts).to.equal(2);
        expect(resCustom.customOk).to.be.true;
    });

    it("rejects when structured retries are exhausted", async () => {
        let attempts = 0;
        const failStep = Step.create(() => {
            attempts++;
            throw new Error("permanent failure");
        }).onFail({
            maxRetries: 2,
            delay: 0
        });

        try {
            await failStep.execute({});
            expect.fail("Should have rejected");
        } catch (err: any) {
            expect(attempts).to.equal(3);
            expect(err.error.message).to.equal("permanent failure");
        }
    });

    it("rejects when onfail is an invalid type", async () => {
        const invalidStep = Step.create(() => {
            throw new Error("broken");
        });
        (invalidStep as any).onfail = 12345;

        try {
            await invalidStep.execute({});
            expect.fail("Should have rejected");
        } catch (err: any) {
            expect(err.error.message).to.equal("broken");
        }
    });

    it("supports structured onFail on named string chain", async () => {
        let namedRetried = false;
        const namedStep = Step.create("namedRetryStep", () => {
            if (!namedRetried) {
                namedRetried = true;
                throw new Error("fail once");
            }
            return {namedOk: true};
        })
            .onFail({
                maxRetries: 2,
                delay: 0
            });

        const res = await Step.start(namedStep);
        expect(res.namedOk).to.be.true;
    });

    describe("Standard Schema, Generics & AbortSignal cancellation", () => {
        it("supports chain.schema() with Standard Schema", async () => {
            const schemaStep = Step.create((param: any) => ({
                doubled: param.num * 2
            })).schema({
                "~standard": {
                    version: 1,
                    vendor: "test",
                    validate: (val: any) => {
                        if (val.num < 0) {
                            return {issues: [{path: ["num"], message: "num must be non-negative"}]};
                        }
                        return {value: val};
                    }
                }
            });

            const res = await schemaStep.run({num: 5});
            expect(res.doubled).to.equal(10);

            try {
                await schemaStep.run({num: -1});
                expect.fail("Should have failed schema validation");
            } catch (err: any) {
                const msg = err.error?.[0]?.error?.message || err.error?.[0]?.message || err.error?.message || err.message;
                expect(msg).to.include("num must be non-negative");
            }
        });

        it("supports chain.spec(schema) when first argument is a schema object", async () => {
            const schemaStep = Step.create((param: any) => ({
                output: param.text + "!"
            })).spec({
                safeParse: (val: any) => {
                    if (!val.text) {
                        return {success: false, error: {message: "text required"}};
                    }
                    return {success: true, data: val};
                }
            });

            const res = await schemaStep.run({text: "hello"});
            expect(res.output).to.equal("hello!");

            try {
                await schemaStep.run({});
                expect.fail("Should have failed");
            } catch (err: any) {
                const msg = err.error?.[0]?.error?.message || err.error?.[0]?.message || err.error?.message || err.message;
                expect(msg).to.include("text required");
            }
        });

        it("supports chain.spec('field', schema) with safeParse", async () => {
            const fieldSchemaStep = Step.create((param: any) => ({
                valid: true
            })).spec("score", {
                safeParse: (val: any) => {
                    if (val < 50) return {success: false, error: {message: "Score too low"}};
                    return {success: true, data: val};
                }
            });

            const res = await fieldSchemaStep.run({score: 85});
            expect(res.valid).to.be.true;

            try {
                await fieldSchemaStep.run({score: 20});
                expect.fail("Should have failed");
            } catch (err: any) {
                const msg = err.error?.[0]?.error?.message || err.error?.[0]?.message || err.error?.message || err.message;
                expect(msg).to.include("Score too low");
            }
        });

        it("supports chain.spec('field', { schema: schemaObj })", async () => {
            const specWithSchemaStep = Step.create((param: any) => ({
                confirmed: true
            })).spec("age", {
                require: true,
                schema: (val: any) => val >= 18
            });

            const res = await specWithSchemaStep.run({age: 25});
            expect(res.confirmed).to.be.true;

            try {
                await specWithSchemaStep.run({age: 16});
                expect.fail("Should have failed");
            } catch (err: any) {
                const msg = err.error?.[0]?.error?.message || err.error?.[0]?.message || err.error?.message || err.message;
                expect(msg).to.include('Validation failed for field "age"');
            }
        });

        it("supports end-to-end TypeScript generics on Step and pipe", async () => {
            interface CartInput {
                cartId: string;
                amount: number;
            }

            interface PaymentOutput {
                status: string;
                total: number;
            }

            const paymentStep = Step.create<CartInput, PaymentOutput>((param: any) => {
                return {
                    status: "paid",
                    total: Math.round(param.amount * 1.1)
                };
            });

            const res = await paymentStep.run({cartId: "c_1", amount: 100});
            expect(res.status).to.equal("paid");
            expect(res.total).to.equal(110);

            const typedPipeline = flow<CartInput, PaymentOutput>(paymentStep);
            const pipeRes = await typedPipeline.run({cartId: "c_2", amount: 200});
            expect(pipeRes.status).to.equal("paid");
            expect(pipeRes.total).to.equal(220);
        });

        it("rejects immediately if signal is already aborted prior to execution", async () => {
            const controller = new AbortController();
            controller.abort(new Error("Pre-aborted signal"));

            const chain = Step.create(() => ({done: true}));

            try {
                await chain.execute({}, {signal: controller.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Pre-aborted signal");
            }

            try {
                await chain.run({}, {signal: controller.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Pre-aborted signal");
            }

            try {
                await flow(chain).run({}, {signal: controller.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Pre-aborted signal");
            }

            try {
                await Step.start(chain, {signal: controller.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Pre-aborted signal");
            }
        });

        it("aborts in-flight async execution when signal fires abort", async () => {
            const controller = new AbortController();

            const longRunningStep = Step.create(async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return {finished: true};
            });

            const runPromise = longRunningStep.run({}, {signal: controller.signal});

            setTimeout(() => {
                controller.abort(new Error("Execution cancelled by user"));
            }, 10);

            try {
                await runPromise;
                expect.fail("Should have aborted");
            } catch (err: any) {
                const msg = err.error?.message || err.message;
                expect(msg).to.equal("Execution cancelled by user");
            }
        });

        it("aborts between steps in array-chain when signal fires", async () => {
            const controller = new AbortController();
            let step2Executed = false;

            const step1 = Step.create(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                controller.abort(new Error("Aborted after step 1"));
                return {step1: true};
            });

            const step2 = Step.create(() => {
                step2Executed = true;
                return {step2: true};
            });

            try {
                await flow(step1, step2).run({}, {signal: controller.signal});
                expect.fail("Should have aborted");
            } catch (err: any) {
                const msg = err.error?.message || err.message;
                expect(msg).to.equal("Aborted after step 1");
                expect(step2Executed).to.be.false;
            }
        });

        it("aborts array-chain if signal is already aborted", async () => {
            const controller = new AbortController();
            controller.abort(new Error("Already dead"));

            const step1 = Step.create(() => ({s1: true}));
            const step2 = Step.create(() => ({s2: true}));

            try {
                await Step.start([step1, step2], {}, {signal: controller.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Already dead");
            }
        });

        it("exposes $signal and signal to chain parameter context", async () => {
            const controller = new AbortController();
            let receivedSignalViaMethod: any;
            let receivedSignalViaProxy: any;

            const chain = Step.create((param: any) => {
                receivedSignalViaMethod = typeof param.$signal === "function" ? param.$signal() : param.$signal;
                receivedSignalViaProxy = param.signal;
                return {ok: true};
            });

            await chain.run({}, {signal: controller.signal});
            expect(receivedSignalViaMethod).to.equal(controller.signal);
            expect(receivedSignalViaProxy).to.equal(controller.signal);
        });

        it("aborts onFail retries when signal is aborted during retry delay", async () => {
            const controller = new AbortController();
            let attempts = 0;

            const retryStep = Step.create(() => {
                attempts++;
                throw new Error(`Attempt ${attempts} failed`);
            }).onFail({
                maxRetries: 3,
                delay: 20
            });

            const runPromise = retryStep.run({}, {signal: controller.signal});

            setTimeout(() => {
                controller.abort(new Error("Retry aborted"));
            }, 5);

            try {
                await runPromise;
                expect.fail("Should have aborted retry");
            } catch (err: any) {
                const msg = err.error?.message || err.message;
                expect(msg).to.equal("Retry aborted");
            }
        });

        it("aborts onFail manual retry when signal is aborted", (done) => {
            const controller = new AbortController();
            controller.abort(new Error("Manual retry aborted"));

            const manualRetryStep = Step.create(() => {
                throw new Error("First failure");
            }).onFail((_err, retry) => {
                retry();
            });

            manualRetryStep.run({}, {signal: controller.signal}).catch((err) => {
                const msg = err.error?.message || err.message;
                expect(msg).to.equal("Manual retry aborted");
                done();
            });
        });
    });

    describe("Recording chain process per stackId", () => {
        it("records execution progress per stackId using logMonitor", async () => {
            const records: Record<string, { status: string; events: any[] }> = {};
            let activeStack: string;

            Step.config({
                logMonitor: (entry: any) => {
                    if (entry.source === "Runner") {
                        if (typeof entry.message === "string" && entry.message.startsWith("Started sequence stack#")) {
                            activeStack = entry.message.replace("Started sequence stack#", "");
                            records[activeStack] = {status: "STARTED", events: []};
                        } else if (typeof entry.message === "string" && entry.message.startsWith("Completed stack#")) {
                            const completedStack = entry.message.replace("Completed stack#", "");
                            if (records[completedStack]) {
                                records[completedStack].status = "COMPLETED";
                            }
                        }
                    } else if (entry.source === "SingleChain" && activeStack && records[activeStack]) {
                        records[activeStack].events.push(entry.message);
                    }
                }
            });

            const step1 = Step.create<{ count: number }, { step1Done: boolean }>(({count}) => ({
                step1Done: true,
                count: count + 10
            }));
            const step2 = Step.create<{ count: number; step1Done: boolean }, {
                step1Done: boolean;
                step2Done: boolean
            }>(({count, step1Done}) => ({
                step1Done,
                step2Done: true,
                count: count * 2
            }));

            const pipeline = flow(step1, step2);
            const result = await pipeline.run({count: 5});

            expect((result as any).count).to.equal(30);
            expect((result as any).step1Done).to.be.true;
            expect((result as any).step2Done).to.be.true;

            const capturedStackIds = Object.keys(records);
            expect(capturedStackIds.length).to.be.greaterThan(0);

            const lastStackId = capturedStackIds[capturedStackIds.length - 1];
            expect(records[lastStackId].status).to.equal("COMPLETED");
            expect(records[lastStackId].events.length).to.be.greaterThan(0);
        });

        it("intercepts addChainToStack on StorageManager to record steps per stackId", async () => {
            const stackLedger = new Map<string, string[]>();

            const origAddChain = defaultStorageManager.addChainToStack.bind(defaultStorageManager);
            defaultStorageManager.addChainToStack = (stackId: string, stepId: string) => {
                if (!stackLedger.has(stackId)) {
                    stackLedger.set(stackId, []);
                }
                stackLedger.get(stackId)!.push(stepId);
                origAddChain(stackId, stepId);
            };

            try {
                const c1 = Step.create<{ val: number }, { val: number }>(({val}) => ({val: val + 1}));
                const c2 = Step.create<{ val: number }, { val: number }>(({val}) => ({val: val * 3}));

                await flow(c1, c2).run({val: 2});

                expect(stackLedger.size).to.be.greaterThan(0);
                const recordedStacks = Array.from(stackLedger.entries());
                const [stackId, stepIds] = recordedStacks[recordedStacks.length - 1];
                expect(stackId).to.be.a("string");
                expect(stepIds.length).to.equal(3);
                stepIds.forEach(id => expect(id).to.be.a("string"));
            } finally {
                defaultStorageManager.addChainToStack = origAddChain;
            }
        });


        it("passes stackId to setPutChainContextPlugin during pipeline execution", async () => {
            const contextEntries: Array<{ stepId: string; field: string; val: any; stackId?: string }> = [];
            const state = defaultStorageManager.getState();

            setPutChainContextPlugin((stepId: string, field: string, getter: () => any, meta?: any) => {
                const val = getter();
                contextEntries.push({
                    stepId,
                    field,
                    val,
                    stackId: meta?.stackId
                });
                let ctx = state.contexts.get(stepId);
                if (!ctx) {
                    ctx = {};
                    state.contexts.set(stepId, ctx);
                }
                ctx[field] = () => val;
            });

            try {
                const step = Step.create<{ num: number }, { result: number }>(({num}) => ({
                    result: num * 10
                }));

                await step.run({num: 7});

                expect(contextEntries.length).to.be.greaterThan(0);
                const stepEntry = contextEntries.find(e => e.field === "result");
                expect(stepEntry).to.not.be.undefined;
                expect(stepEntry!.val).to.equal(70);
                expect(stepEntry!.stackId).to.be.a("string");
            } finally {
                clearStorage();
            }
        });

        it("captures stackId on execution failure", async () => {
            const failingStep = Step.create(() => {
                throw new Error("Deliberate failure for stackId tracking");
            });

            try {
                await failingStep.run({});
                expect.fail("Should have failed");
            } catch (err: any) {
                expect(err.stackId).to.be.a("string");
                expect(err.error.message).to.equal("Deliberate failure for stackId tracking");
            }
        });
    });
    describe("Step onSkip & onAfter lifecycles", () => {
        it("supports synchronous onSkip with fallback data when onBefore returns false", async () => {
            const skipStep = Step.create("syncSkipStep", () => ({ran: true}))
                .onBefore(() => false)
                .onSkip((param: any) => ({
                    skipped: true,
                    reason: "condition_unmet",
                    receivedInput: param.initVal
                }));

            const res: any = await skipStep.execute({initVal: "hello"});
            expect(res.skipped).to.be.true;
            expect(res.reason).to.equal("condition_unmet");
            expect(res.receivedInput).to.equal("hello");
            expect(res.ran).to.be.undefined;
        });

        it("supports asynchronous onSkip with Promise fallback when onBefore returns Promise(false)", async () => {
            const asyncSkipStep = Step.create("asyncSkipStep", () => ({executed: true}))
                .onBefore(async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return false;
                })
                .onSkip(async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return {asyncSkipped: true, fallbackCode: 204};
                });

            const res: any = await asyncSkipStep.run({});
            expect(res.asyncSkipped).to.be.true;
            expect(res.fallbackCode).to.equal(204);
            expect(res.executed).to.be.undefined;
        });

        it("supports onSkip returning undefined for pure side-effect without failing", async () => {
            let sideEffectLogged = false;
            const sideEffectStep = Step.create("sideEffectSkipStep", () => ({actionRan: true}))
                .onBefore(() => false)
                .onSkip(() => {
                    sideEffectLogged = true;
                    return undefined;
                });

            const res = await sideEffectStep.run({});
            expect(sideEffectLogged).to.be.true;
            expect(res.actionRan).to.be.undefined;
        });

        it("unwraps raw parameters in onSkip when chain is modern", async () => {
            let capturedParam: any;
            const modernSkipStep = Step.create(({age}: any) => ({canDrink: age >= 21}))

                .onBefore(({age}: any) => age >= 21)
                .onSkip((param: any) => {
                    capturedParam = param;
                    return {canDrink: false, reason: "underage"};
                });

            const res: any = await modernSkipStep.run({age: 19});
            expect(capturedParam).to.deep.equal({age: 19});
            expect(res.canDrink).to.be.false;
            expect(res.reason).to.equal("underage");
        });

        it("routes errors thrown in onSkip to onFail", async () => {
            const throwSkipStep = Step.create("throwSkipStep", () => ({ok: true}))
                .onBefore(() => false)
                .onSkip(() => {
                    throw new Error("Skip handler failed");
                })
                .onFail((err: any, _retry: any, reject: any) => {
                    expect(err.message).to.equal("Skip handler failed");
                    reject();
                });

            try {
                await throwSkipStep.run({});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.error.message).to.equal("Skip handler failed");
            }
        });

        it("supports synchronous onAfter enriching the context with new properties", async () => {
            let capturedParam: any;
            const enrichStep = Step.create("enrichStep", (param: any) => ({
                orderId: "ord_100",
                amount: param.basePrice * 2
            }))
                .onAfter((output: any, param: any) => {
                    capturedParam = param;
                    return {
                        tax: 15,
                        total: output.amount + 15
                    };
                });

            const res: any = await enrichStep.run({basePrice: 50});
            expect(capturedParam.basePrice).to.equal(50);
            expect(res.orderId).to.equal("ord_100");
            expect(res.amount).to.equal(100);
            expect(res.tax).to.equal(15);
            expect(res.total).to.equal(115);
        });

        it("supports asynchronous onAfter returning Promise to enrich context", async () => {
            const asyncAfterStep = Step.create("asyncAfterStep", async () => ({initialStatus: "pending"}))
                .onAfter(async (output: any) => {
                    await new Promise(r => setTimeout(r, 10));
                    return {
                        finalStatus: "confirmed",
                        prevStatus: output.initialStatus
                    };
                });

            const res: any = await asyncAfterStep.run({});
            expect(res.initialStatus).to.equal("pending");
            expect(res.finalStatus).to.equal("confirmed");
            expect(res.prevStatus).to.equal("pending");
        });

        it("supports onAfter returning undefined for pure side-effect while preserving output", async () => {
            let sideEffectTracked = false;
            const trackStep = Step.create("trackStep", () => ({computed: 42}))
                .onAfter((output: any) => {
                    if (output.computed === 42) {
                        sideEffectTracked = true;
                    }
                    return undefined;
                });

            const res = await trackStep.run({});
            expect(sideEffectTracked).to.be.true;
            expect(res.computed).to.equal(42);
        });

        it("unwraps raw parameters in onAfter when chain is modern", async () => {
            let capturedParam: any;
            let capturedOutput: any;
            const modernAfterStep = Step.create(({x, y}: any) => ({sum: x + y}))

                .onAfter((output: any, param: any) => {
                    capturedOutput = output;
                    capturedParam = param;
                    return {doubled: output.sum * 2};
                });

            const res: any = await modernAfterStep.run({x: 10, y: 20});
            expect(capturedParam).to.deep.equal({x: 10, y: 20});
            expect(capturedOutput).to.deep.equal({sum: 30});
            expect(res.sum).to.equal(30);
            expect(res.doubled).to.equal(60);
        });

        it("routes errors thrown in onAfter to onFail for retry and recovery", async () => {
            let attempts = 0;
            const retryAfterStep = Step.create("retryAfterStep", () => ({stepResult: "ok"}))
                .onAfter(() => {
                    attempts++;
                    if (attempts < 2) {
                        throw new Error("After hook transient error");
                    }
                    return {afterDone: true};
                })
                .onFail((err: any, retry: any) => {
                    expect(err.message).to.equal("After hook transient error");
                    retry();
                });

            const res: any = await retryAfterStep.run({});
            expect(attempts).to.equal(2);
            expect(res.stepResult).to.equal("ok");
            expect(res.afterDone).to.be.true;
        });

        it("supports onAfter on reducer chains (.reduce)", async () => {
            const reduceStep = Step.create("reduceWithAfter", (param: any, current: number) => ({
                accum: (param.accum || 0) + current
            }))
                .reduce("nums")
                .onAfter((result: any) => {
                    return {
                        isEven: result.accum % 2 === 0,
                        tag: "reduced"
                    };
                });

            const res: any = await reduceStep.run({nums: [1, 2, 3, 4]});
            expect(res.accum).to.equal(10);
            expect(res.isEven).to.be.true;
            expect(res.tag).to.equal("reduced");
        });

        it("integrates onSkip and onAfter seamlessly in a multi-step pipeline", async () => {
            const checkUser = Step.create(({user}: any) => ({validUser: true}))

                .onBefore(({user}: any) => user?.isActive === true)
                .onSkip(() => ({
                    validUser: false,
                    skipReason: "user_inactive"
                }));

            const processOrder = Step.create(({validUser, skipReason, orderTotal}: any) => {
                if (!validUser) {
                    return {orderProcessed: false, status: skipReason};
                }
                return {orderProcessed: true, status: "charged"};
            })

                .onAfter((output: any) => ({
                    completedAt: 123456789
                }));

            const pipeline = flow(checkUser, processOrder);

            // Test skipped branch
            const inactiveRes = await pipeline.run({user: {isActive: false}, orderTotal: 100});
            expect((inactiveRes as any).orderProcessed).to.be.false;
            expect((inactiveRes as any).status).to.equal("user_inactive");
            expect((inactiveRes as any).completedAt).to.equal(123456789);

            // Test active branch
            const activeRes = await pipeline.run({user: {isActive: true}, orderTotal: 100});
            expect((activeRes as any).orderProcessed).to.be.true;
            expect((activeRes as any).status).to.equal("charged");
            expect((activeRes as any).completedAt).to.equal(123456789);
        });
    });

    describe("State Management Enhancements (Recommendations 1 - 4)", () => {
        it("Rec 1: tracks step-namespaced history via $steps and $history across pipeline steps with collisions", async () => {
            const step1 = Step.create("validateOrder", () => ({
                status: "validated",
                orderId: "ord_1"
            }));
            const step2 = Step.create("processPayment", (param: any) => {
                expect(param.$steps.validateOrder.status).to.equal("validated");
                expect(param.$history[0].status).to.equal("validated");
                expect(param.$steps("validateOrder").status).to.equal("validated");
                return {
                    status: "paid",
                    paymentId: "pay_99"
                };
            });
            const step3 = Step.create("notifyCustomer", (param: any) => {
                expect(param.$steps.validateOrder.status).to.equal("validated");
                expect(param.$steps.processPayment.status).to.equal("paid");
                expect(param.$history[1].status).to.equal("paid");
                return {
                    status: "notified"
                };
            });

            const pipeline = flow(step1, step2, step3);
            const res: any = await pipeline.run({customer: "Alice"});

            expect(res.status).to.equal("notified");
            expect(res.$steps.validateOrder.status).to.equal("validated");
            expect(res.$steps.processPayment.status).to.equal("paid");
            expect(res.$steps.notifyCustomer.status).to.equal("notified");
            expect(res.$history[0].status).to.equal("validated");
            expect(res.$history[1].status).to.equal("paid");
            expect(res.$history[2].status).to.equal("notified");
            expect(res.$steps("processPayment").paymentId).to.equal("pay_99");
        });

        it("Rec 1: supports  destructuring with $steps and $history", async () => {
            const stepA = Step.create("stepA", () => ({code: "A1"}));
            const stepB = Step.create("stepB", ({$steps, $history}: any) => {
                expect($steps.stepA.code).to.equal("A1");
                expect($history[0].code).to.equal("A1");
                return {code: "B2", fromA: $steps.stepA.code};
            });

            const res: any = await flow(stepA, stepB).run();
            expect(res.code).to.equal("B2");
            expect(res.fromA).to.equal("A1");
            expect(res.$steps.stepA.code).to.equal("A1");
        });

        it("Rec 2: pure functional context passing preserves input object immutability", async () => {
            const originalInput = Object.freeze({
                userId: "user_42",
                details: Object.freeze({tier: "gold"})
            });

            const step1 = Step.create("step1", () => ({step1Done: true}));
            const step2 = Step.create("step2", () => ({step2Done: true}));

            const res = await flow(step1, step2).run(originalInput);
            expect(res.step2Done).to.be.true;
            expect(res.$steps.step1.step1Done).to.be.true;
            expect(Object.keys(originalInput)).to.deep.equal(["userId", "details"]);
            expect((originalInput as any).step1Done).to.be.undefined;
            expect((originalInput as any).step2Done).to.be.undefined;
        });

        it("Rec 3: lightweight POJO execution mode returns frozen plain objects without Proxy wrapper", async () => {
            const step1 = Step.create("s1", (param: any) => ({count: param.count + 5}));
            const step2 = Step.create("s2", (param: any) => ({total: param.count * 2}));

            const res: any = await flow(step1, step2).run({count: 10}, {pojo: true});
            expect(typeof res.total).to.equal("number");
            expect(res.total).to.equal(30);
            expect(res.$steps.s1.count).to.equal(15);
            expect(Object.isFrozen(res)).to.be.true;
            expect(res.$steps.s1.count).to.equal(15);
            expect(res.$steps.s2.total).to.equal(30);
            expect(typeof res.total).to.not.equal("function");

            // Also test single step with mode: "pojo"
            const single = Step.create("singlePojo", () => ({val: 123}));
            const singleRes: any = await single.run({}, {mode: "pojo"});
            expect(singleRes.val).to.equal(123);
            expect(typeof singleRes.val).to.equal("number");

            // Test array chain ending with null / primitive
            const primPipeline = flow(
                Step.create(() => ({stepA: 1})),
                Step.create(() => null)
            );
            const primRes: any = await primPipeline.run();
            expect(primRes.value).to.be.null;
        });

        it("Rec 4: durable execution via checkpointing, serialization, and hydration on Step", async () => {
            clearStorage();
            const stackId = createExecutionStack();
            addChainToStack(stackId, "c_durable1");
            putChainContext("c_durable1", "stepResult", "checkpointedData", {stackId});

            const chk = Step.checkpoint(stackId);
            expect(chk.stackId).to.equal(stackId);
            expect(chk.contexts.c_durable1.stepResult).to.equal("checkpointedData");

            const serialized = Step.serializeState(stackId);
            expect(typeof serialized).to.equal("string");
            clearStorage();

            Step.hydrateState(serialized);
            expect(getChainContext("c_durable1", "stepResult")()).to.equal("checkpointedData");

            const isolated = new StorageManager();
            isolated.restoreCheckpoint(chk);
            expect(isolated.getChainContext("c_durable1", "stepResult")()).to.equal("checkpointedData");
            clearStorage();
        });
    });

    describe("Step coverage improvements", () => {
        it("handles constructor with undefined nameOrAction and empty name", () => {
            const c1 = new Step();
            expect(c1.name).to.equal("");
            expect(c1.action).to.be.a("function");
            expect(c1.action({})).to.be.undefined;

            const c2 = new Step("");
            expect(c2.name).to.equal("");

            const c3 = Step.create("onlyName");
            expect(c3.name).to.equal("onlyName");
        });

        it("handles execute when sequence is cleared", async () => {
            const emptySeqStep = Step.create("emptySeq", () => ({ok: true}));
            emptySeqStep.sequence = [];
            const res = await emptySeqStep.execute();
            expect(res.ok).to.be.true;
        });

        it("supports spec aliases: defaultValue, validator, transformer, translator, and schema object in json", async () => {
            let capturedVal: any;
            const aliasStep = Step.create("aliasStep", (param: any) => {
                capturedVal = {
                    def: param.fieldDef,
                    upper: param.fieldTrans,
                    translated: param.translatedField
                };
                return {success: true};
            })
                .spec("fieldDef", {
                    defaultValue: "fallbackValue"
                })
                .spec("fieldValid", {
                    validator: async (val: any) => val === "good"
                })
                .spec("fieldTrans", {
                    transformer: async (val: any) => val.toUpperCase()
                })
                .spec("fieldTranslate", {
                    translator: async (val: any, ctx: any) => {
                        ctx.set("translatedField", "got_" + val);
                    }
                })
                .spec("fieldSchema", {
                    schema: {
                        parse: (val: any) => val
                    }
                });

            const res = await aliasStep.run({
                fieldValid: "good",
                fieldTrans: "hello",
                fieldTranslate: "data",
                fieldSchema: 123
            });

            expect(res.success).to.be.true;
            expect(capturedVal.def).to.equal("fallbackValue");
            expect(capturedVal.upper).to.equal("HELLO");
            expect(capturedVal.translated).to.equal("got_data");
        });

        it("supports pipe execution methods and default param", async () => {
            const p = flow(Step.create(() => ({num: 10})));
            const r1 = await p.start();
            expect(r1.num).to.equal(10);

            const r2 = await p.execute();
            expect(r2.num).to.equal(10);

            const r3 = await p.run();
            expect(r3.num).to.equal(10);
        });

        it("exercises re-exports from chain module", () => {
            expect(Step.toPOJO).to.be.a("function");
            expect(stepToPOJO).to.be.a("function");
            const pojo = stepToPOJO({test: 1});
            expect(pojo).to.deep.equal({test: 1});
        });

        it("handles retry with default delay and maxRetries when omitted in config", async () => {
            let attempts = 0;
            const retryDefault = Step.create(() => {
                attempts++;
                if (attempts < 2) {
                    throw new Error("retry with defaults");
                }
                return {recovered: true};
            }).onFail({
                // maxRetries and delay omitted to test defaults (maxRetries: 3, delay: 100)
            });

            const res = await retryDefault.run();
            expect(attempts).to.equal(2);
            expect(res.recovered).to.be.true;
        });

        it("handles retry when initialParam is primitive or undefined", async () => {
            let attempts = 0;
            const noParamRetry = Step.create(() => {
                attempts++;
                if (attempts < 2) {
                    throw new Error("fail once");
                }
                return {ok: true};
            }).onFail({
                maxRetries: 2,
                delay: 0
            });

            const res = await noParamRetry.run(undefined);
            expect(attempts).to.equal(2);
            expect(res.ok).to.be.true;
        });

        it("supports cache with default duration when ms omitted", () => {
            const c = Step.create("defaultCacheStep").cache();
            expect(c.cachedLast).to.equal(1500);
        });

        it("handles constructor with falsy sequence and pre-populated sequence", () => {
            const cNullSeq = new Step("nullSeqStep", undefined, null as any);
            expect(cNullSeq.sequence).to.deep.equal([cNullSeq]);

            const s1 = new Step("step1");
            const s2 = new Step("step2");
            const cPreSeq = new Step("preSeqStep", undefined, [s1, s2]);
            expect(cPreSeq.sequence).to.deep.equal([s1, s2]);
        });

        it("calls static Step.config", () => {
            Step.config({
                logger: {
                    log: () => {
                    },
                    error: () => {
                    },
                    warn: () => {
                    },
                    info: () => {
                    }
                }
            });
        });

        it("supports spec aliases: default, validate, transform, translate", async () => {
            let capturedVal: any;
            const aliasStep = Step.create("aliasDirectStep", (param: any) => {
                capturedVal = {
                    def: param.fieldDef,
                    valid: param.fieldValid,
                    upper: param.fieldTrans,
                    translated: param.translatedField
                };
                return {success: true};
            })
                .spec("fieldDef", {
                    default: "directDefaultValue"
                })
                .spec("fieldValid", {
                    validate: async (val: any) => val === "good"
                })
                .spec("fieldTrans", {
                    transform: async (val: any) => val.toUpperCase()
                })
                .spec("fieldTranslate", {
                    translate: async (val: any, ctx: any) => {
                        ctx.set("translatedField", "translated_" + val);
                    }
                });

            const res = await aliasStep.run({
                fieldValid: "good",
                fieldTrans: "world",
                fieldTranslate: "direct"
            });

            expect(res.success).to.be.true;
            expect(capturedVal.def).to.equal("directDefaultValue");
            expect(capturedVal.upper).to.equal("WORLD");
            expect(capturedVal.translated).to.equal("translated_direct");
        });

        it("handles AbortController with custom abort reason on single and array chains", async () => {
            const controller1 = new AbortController();
            const customError1 = new Error("Custom cancel signal");
            controller1.abort(customError1);

            try {
                await Step.create("abortedSingle", () => ({ok: true})).run({}, {signal: controller1.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Custom cancel signal");
            }

            const controller2 = new AbortController();
            const customError2 = new Error("Array abort reason");
            controller2.abort(customError2);

            try {
                await flow(Step.create(() => ({a: 1}))).run({}, {signal: controller2.signal});
                expect.fail("Should have rejected");
            } catch (err: any) {
                expect(err.message).to.equal("Array abort reason");
            }
        });

        it("handles OnFail when thrown error is falsy or anonymous step retries", async () => {
            let caughtFalsyError: any;
            const throwFalsyStep = Step.create("throwFalsy", () => {
                throw null;
            }).onFail((err: any, _retry: any, reject: any) => {
                caughtFalsyError = err;
                reject(err);
            });

            try {
                await throwFalsyStep.run();
                expect.fail("Should have failed");
            } catch (err: any) {
                expect(caughtFalsyError).to.be.an("object");
                expect(caughtFalsyError.func).to.equal("throwFalsy");
            }

            let anonAttempts = 0;
            const anonRetryStep = new Step("", () => {
                anonAttempts++;
                if (anonAttempts < 2) {
                    throw new Error("anon fail");
                }
                return {anonOk: true};
            }).onFail({
                maxRetries: 2,
                delay: 0
            });

            const anonRes = await anonRetryStep.run();
            expect(anonAttempts).to.equal(2);
            expect(anonRes.anonOk).to.be.true;
        });

        it("handles OnAfter when chain returns null, undefined, or primitive", async () => {
            let afterReceivedOut: any;
            const nullStep: Step<any, any> = Step.create("nullStep", () => null)
                .onAfter((output: any) => {
                    afterReceivedOut = output;
                    return {handledNull: true};
                });

            const nullRes = await nullStep.run();
            expect(afterReceivedOut).to.be.null;
            expect(nullRes.handledNull).to.be.true;

            let afterReceivedUndef: any;
            const undefStep = Step.create("undefStep", () => undefined)
                .onAfter((output: any) => {
                    afterReceivedUndef = output;
                    return {handledUndef: true};
                });

            const undefRes: FlowContextResult<any> = await undefStep.run();
            expect(afterReceivedUndef).to.be.undefined;
            expect(undefRes.handledUndef).to.be.true;
        });

        it("handles Reducer when array is undefined or missing", async () => {
            const reduceMissing = Step.create("reduceMissing", (param: any, current: any) => ({
                sum: (param.sum ? param.sum : 0) + current
            }))
                .reduce("missingList");

            const res: FlowContextResult<any> = await reduceMissing.run({});
            expect(Number.isNaN(res.sum)).to.be.true;
        });

        it("supports pipeline as argument in flow() sequentially and nested", async () => {
            const step1 = Step.create("step1", (param: any) => ({a: Number(param.input || 0) + 1}));
            const step2 = Step.create("step2", (param: any) => ({b: param.a * 2}));
            const subPipe1 = flow(step1, step2);

            const step3 = Step.create("step3", (param: any) => ({c: param.b + 10}));
            const subPipe2 = flow(step3);

            const masterPipeline = flow(subPipe1, subPipe2);
            expect(masterPipeline.steps.length).to.equal(3);

            const res = await masterPipeline.run({input: 5});
            expect(res.c).to.equal(22);
            expect(res.$steps.step1.a).to.equal(6);
            expect(res.$steps.step2.b).to.equal(12);
            expect(res.$steps.step3.c).to.equal(22);
        });

        it("supports pipeline inside nested arrays and mixed with chains in flow()", async () => {
            const stepA = Step.create("stepA", () => ({stepA: true}));
            const stepB = Step.create("stepB", () => ({stepB: true}));
            const sub = flow(stepA);
            const stepC = Step.create("stepC", () => ({stepC: true}));

            const master = flow([sub, [stepB]], stepC);
            const res = await master.run({}, {pojo: true});
            expect(res.stepC).to.be.true;
            expect(res.$steps.stepA.stepA).to.be.true;
            expect(res.$steps.stepB.stepB).to.be.true;
            expect(res.$steps.stepC.stepC).to.be.true;
        });

        it("supports custom pipeline without .chains in flow() and Step.start()", async () => {
            const customPipe = {
                run: async (param: any) => ({fromCustom: (param.seed || 1) * 3}),
                execute: async (param: any) => ({fromCustom: (param.seed || 1) * 3}),
                start: async (param: any) => ({fromCustom: (param.seed || 1) * 3})
            };

            // in flow()
            const p = flow(Step.create(() => ({seed: 10})), customPipe as any);
            const pRes: FlowContextResult<any> = await p.run({});
            expect(pRes.fromCustom).to.equal(30);

            // in Step.start()
            const sRes: FlowContextResult<any> = await Step.start(customPipe as any, {seed: 5});
            expect(sRes.fromCustom).to.equal(15);
        });

        it("supports Step.create(pipeline) and Step.start(pipeline)", async () => {
            const sub = flow(Step.create(() => ({subVal: 99})));

            // Step.create(pipeline)
            const wrappedStep = Step.create(sub);
            const resWrapped = await wrappedStep.run();
            expect(resWrapped.subVal).to.equal(99);

            // Step.start(pipeline)
            const startRes = await Step.start(sub);
            expect(startRes.subVal).to.equal(99);
        });

        it("correctly identifies flows with isFlow", () => {
            const p = flow(Step.create(() => ({})));
            expect(Step.isFlow(p)).to.be.true;
            expect(isFlow(p)).to.be.true;

            const custom = {
                run: () => {
                }, execute: () => {
                }
            };
            expect(isFlow(custom)).to.be.true;

            const stepInstance = Step.create(() => ({}));
            expect(isFlow(stepInstance)).to.be.false;

            expect(isFlow(null)).to.be.false;
            expect(isFlow(undefined)).to.be.false;
            expect(isFlow("some string")).to.be.false;
            expect(isFlow({})).to.be.false;
        });
    });

    describe("Option B: Step and Flow Architecture", () => {
        it("creates and executes workflows using Step and flow orchestrator", async () => {
            const validate = Step.create("optB_val", async (param: any) => ({valid: Boolean(param.cartId)}));
            const charge = Step.create("optB_charge", async (param: any) => ({charged: true, amount: 100}));
            const checkout = flow(validate, charge);

            expect(checkout.isFlow).to.be.true;
            expect(checkout.steps.length).to.equal(2);
            expect(isFlow(checkout)).to.be.true;

            const res = await checkout.run({cartId: "123"});
            expect(res.charged).to.be.true;
            expect(res.amount).to.equal(100);
            expect(res.$steps.optB_val.valid).to.be.true;
            expect(res.$steps.optB_charge.charged).to.be.true;
        });

        it("supports nested flows inside flow() orchestrator", async () => {
            const stepA = Step.create("optB_stepA", () => ({a: 1}));
            const stepB = Step.create("optB_stepB", () => ({b: 2}));
            const subFlow = flow(stepA, stepB);

            const stepC = Step.create("optB_stepC", () => ({c: 3}));
            const topFlow = flow(subFlow, stepC);

            expect(topFlow.steps.length).to.equal(3);
            const res = await topFlow.run({}, {pojo: true});
            expect(res.c).to.equal(3);
            expect(res.$steps.optB_stepA.a).to.equal(1);
            expect(res.$steps.optB_stepB.b).to.equal(2);
            expect(res.$steps.optB_stepC.c).to.equal(3);
        });

        it("supports Step.flow as static orchestrator", async () => {
            const s1 = Step.create(() => ({part1: "hello"}));
            const s2 = Step.create((param: any) => ({part2: param.part1 + " world"}));
            const myFlow = Step.flow(s1, s2);

            const res = await myFlow.execute();
            expect(res.part2).to.equal("hello world");
        });

        it("supports aliases pipe, isPipeline, and Pipeline", async () => {
            expect(pipe).to.equal(flow);
            expect(isPipeline).to.equal(isFlow);
            expect(Step.pipe).to.equal(flow);
            expect(Step.isPipeline).to.equal(isFlow);

            const testStep = Step.create(() => ({legacy: true}));
            const legacyPipeline = pipe(testStep);
            expect(isPipeline(legacyPipeline)).to.be.true;
            const res = await legacyPipeline.run();
            expect(res.legacy).to.be.true;
        });

        it("handles sanitizeFlowData with non-object and primitives in subflows", async () => {
            const returnPrimFlow = {
                run: async () => "primitive_string"
            };
            const wrapped = Step.create(returnPrimFlow as any);
            const res = await wrapped.run();
            expect(res.value).to.equal("primitive_string");
        });
    });


    describe('Phase 4: TypeScript and Developer Experience', () => {
        describe('Accumulated Context & Typed Step History', () => {
            it('should accumulate context across sequential steps and record history', async () => {
                const step1 = Step.create('fetchUser', (param: { userId: string }) => {
                    return {name: 'Alice', age: 30};
                });

                const step2 = Step.create('enrichProfile', (param: { name: string; age: number; $steps?: any }) => {
                    expect(param.name).to.equal('Alice');
                    expect(param.age).to.equal(30);
                    expect(param.$steps?.fetchUser).to.deep.equal({name: 'Alice', age: 30});
                    return {role: 'admin'};
                });

                const workflow = flow(step1, step2);
                const result = await workflow.run({userId: 'u-123'}, {pojo: true});

                expect(result.name).to.equal('Alice');
                expect(result.age).to.equal(30);
                expect(result.role).to.equal('admin');
                expect(result.$steps?.fetchUser).to.deep.equal({name: 'Alice', age: 30});
                expect(result.$steps?.enrichProfile).to.deep.equal({role: 'admin'});
            });

            it('should handle void step output without altering context', async () => {
                const step1 = Step.create('init', () => ({count: 1}));
                const step2 = Step.create('noop', (_param: { count: number }) => {
                    // returns undefined / void
                });
                const step3 = Step.create('inc', (param: { count: number }) => ({count: param.count + 1}));

                const workflow = flow(step1, step2, step3);
                const result = await workflow.run({}, {pojo: true});
                expect(result.count).to.equal(2);
            });
        });

        describe('Dependency Injection & Services', () => {
            it('should inject step-level dependencies via withDependencies() and requireDependency()', async () => {
                const step = Step.create('callApi', (param: any) => {
                    const client = param.$services?.apiClient || param.$dependencies?.apiClient;
                    return {fetched: client.getData()};
                });

                step.withDependencies({
                    apiClient: {getData: () => 'from-dep'}
                });

                expect(step.requireDependency('apiClient')).to.deep.equal({getData: step.dependencies!.apiClient.getData});
                expect(() => step.requireDependency('missingDep')).to.throw("Missing required dependency 'missingDep' for step 'callApi'");

                const anonStep = Step.create(() => ({}));
                expect(() => anonStep.requireDependency('foo')).to.throw("Missing required dependency 'foo' for step 'anonymous'");

                const result = await step.execute({}, {pojo: true});
                expect(result.fetched).to.equal('from-dep');
            });

            it('should inject workflow-level services via options.services and merge with step dependencies', async () => {
                const loggerMock = {log: (msg: string) => msg};
                const dbMock = {query: () => ['row1']};

                let capturedServices: any;
                let capturedDeps: any;
                let capturedDollarDeps: any;

                const step = Step.create('dbStep', (param: any) => {
                    capturedServices = param.$services;
                    capturedDeps = param.$dependencies;
                    capturedDollarDeps = param.$deps;
                    return {
                        dbResult: param.$services.db.query(),
                        logged: param.$services.logger.log('hello')
                    };
                }).withDependencies({
                    db: dbMock
                });

                const wf = flow(step);
                const result = await wf.run({}, {
                    pojo: true,
                    services: {
                        logger: loggerMock
                    }
                });

                expect(result.dbResult).to.deep.equal(['row1']);
                expect(result.logged).to.equal('hello');
                expect(capturedServices.logger).to.equal(loggerMock);
                expect(capturedServices.db).to.equal(dbMock);
                expect(capturedDeps).to.equal(capturedServices);
                expect(capturedDollarDeps).to.equal(capturedServices);
            });

            it('should support options.dependencies fallback for services', async () => {
                const step = Step.create('testStep', (param: any) => {
                    return {configVal: param.$services.config.env};
                });

                const res = await step.execute({}, {
                    pojo: true,
                    dependencies: {
                        config: {env: 'staging'}
                    }
                });

                expect(res.configVal).to.equal('staging');
            });
        });

        describe('Workflow Visualization & Export APIs', () => {
            it('should export workflow and steps to Mermaid diagram with badges', () => {
                const s1 = Step.create('step1', () => ({a: 1}))
                    .timeout(5000)
                    .onFail({maxRetries: 3, delay: 100})
                    .cache(2000)
                    .compensate(() => {
                    });

                const s2 = wait(1000);
                const s3 = branch(
                    (p: any) => p.a === 1,
                    Step.create('branchTrue', () => ({ok: true})),
                    Step.create('branchFalse', () => ({ok: false}))
                );
                const s4 = parallel([
                    Step.create('parallelA', () => ({a: 'done'})),
                    Step.create('parallelB', () => ({b: 'done'}))
                ]);
                const s5 = map(
                    (p: any) => p.items,
                    Step.create('mapItem', (item: any) => item * 2)
                );

                const wf = flow(s1, s2, s3, s4, s5);

                // flow.toMermaid()
                const mermaidTD = wf.toMermaid();
                expect(mermaidTD).to.include('flowchart TD');
                expect(mermaidTD).to.include('⏱️ 5000ms');
                expect(mermaidTD).to.include('🔁 retry(3)');
                expect(mermaidTD).to.include('⏪ saga');
                expect(mermaidTD).to.include('💾 cache');
                expect(mermaidTD).to.include('⏳ wait');

                // options.direction & includeBadges
                const mermaidLR = toMermaid(wf, {direction: 'LR', includeBadges: false});
                expect(mermaidLR).to.include('flowchart LR');
                expect(mermaidLR).to.not.include('⏱️');

                // static Step.toMermaid
                const stepMermaid = Step.toMermaid(s1);
                expect(stepMermaid).to.include('flowchart TD');
                expect(stepMermaid).to.include('step1');
            });

            it('should export workflow to JSON AST and sanitize functions', () => {
                const s1 = Step.create('step1', () => ({a: 1}));
                const s2 = Step.create('step2', () => ({b: 2}));
                const wf = flow(s1, s2);

                const jsonStr = wf.toJSON();
                const parsed = JSON.parse(jsonStr);
                expect(parsed).to.have.property('type', 'sequence');
                expect(parsed).to.have.property('children');
                expect(parsed.children[0]).to.have.property('name', 'step1');
                expect(jsonStr).to.not.include('"action"');

                // Standalone toJSON
                const standaloneJson = toJSON(wf);
                const parsedStandalone = JSON.parse(standaloneJson);
                expect(parsedStandalone).to.have.property('type', 'sequence');
                expect(parsedStandalone.children[0]).to.have.property('name', 'step1');
                expect(standaloneJson).to.not.include('"action"');

                // Static Step.toJSON
                const stepJson = Step.toJSON(s1);
                const parsedStep = JSON.parse(stepJson);
                expect(parsedStep.name).to.equal('step1');

                // Standalone toJSON on single step
                const stepStandaloneJson = toJSON(s1);
                expect(JSON.parse(stepStandaloneJson).name).to.equal('step1');
            });

            it('should export complex workflow with combinators using standalone toJSON() and strip functions', () => {
                const s1 = Step.create('initStep', () => ({count: 1}));
                const sBranch = branch(
                    (p: any) => p.count > 0 ? 'pos' : 'neg',
                    {
                        pos: Step.create('branchPos', () => ({isPos: true})),
                        neg: Step.create('branchNeg', () => ({isPos: false}))
                    }
                );
                const sWait = wait(200);
                const sParallel = parallel([
                    Step.create('parallel1', () => ({})),
                    Step.create('parallel2', () => ({}))
                ]);
                const sMap = map(
                    (p: any) => p.items,
                    Step.create('mapWorker', (x: any) => x)
                );

                const complexWf = flow(s1, sBranch, sWait, sParallel, sMap);
                const jsonOutput = toJSON(complexWf);
                const parsed = JSON.parse(jsonOutput);

                expect(parsed.type).to.equal('sequence');
                expect(parsed.children).to.have.lengthOf(5);
                expect(parsed.children[0].name).to.equal('initStep');
                expect(parsed.children[1].type).to.equal('branch');
                expect(parsed.children[1].branches.pos.name).to.equal('branchPos');
                expect(parsed.children[1].branches.neg.name).to.equal('branchNeg');
                expect(parsed.children[2].type).to.equal('wait');
                expect(parsed.children[3].type).to.equal('parallel');
                expect(parsed.children[3].branches).to.have.lengthOf(2);
                expect(parsed.children[3].branches[0].name).to.equal('parallel1');
                expect(parsed.children[3].branches[1].name).to.equal('parallel2');
                expect(parsed.children[4].type).to.equal('map');
                expect(parsed.children[4].itemNode.name).to.equal('mapWorker');

                // Ensure cyclical/function pointers are sanitized
                expect(jsonOutput).to.not.include('"action"');
                expect(jsonOutput).to.not.include('"selector"');
            });

            it('should export workflow to Graphviz DOT format', () => {
                const s1 = Step.create('step1', () => ({a: 1}))
                    .timeout(3000)
                    .onFail({maxRetries: 2});
                const s2 = wait(500);
                const s3 = branch(
                    () => true,
                    Step.create('branchA', () => ({})),
                    Step.create('branchB', () => ({}))
                );
                const s4 = parallel([Step.create('pA', () => ({}))]);
                const s5 = map((p: any) => p.list, Step.create('mItem', () => ({})));

                const wf = flow(s1, s2, s3, s4, s5);

                const dotStr = wf.toDot({graphName: 'CustomPipeline', direction: 'LR'});
                expect(dotStr).to.include('digraph CustomPipeline {');
                expect(dotStr).to.include('rankdir=LR;');
                expect(dotStr).to.include('shape=diamond');
                expect(dotStr).to.include('shape=ellipse');
                expect(dotStr).to.include('shape=component');
                expect(dotStr).to.include('shape=parallelogram');
                expect(dotStr).to.include('->');

                // Standalone toDot
                const standaloneDot = toDot(wf, {graphName: 'CustomPipeline', direction: 'LR'});
                expect(standaloneDot).to.include('digraph CustomPipeline {');
                expect(standaloneDot).to.include('rankdir=LR;');
                expect(standaloneDot).to.include('shape=diamond');
                expect(standaloneDot).to.include('shape=ellipse');
                expect(standaloneDot).to.include('shape=component');
                expect(standaloneDot).to.include('shape=parallelogram');

                // Static Step.toDot
                const stepDot = Step.toDot(s1);
                expect(stepDot).to.include('digraph Workflow {');
                expect(stepDot).to.include('rankdir=TB;');
            });

            it('should export workflow and steps using standalone toDot() with default options and edge labels', () => {
                const s1 = Step.create('step1', () => ({a: 1}))
                    .timeout(2000)
                    .compensate(() => {});
                const sBranch = branch(
                    (p: any) => p.a === 1 ? 'pos' : 'neg',
                    {
                        pos: Step.create('onTrue', () => ({})),
                        neg: Step.create('onFalse', () => ({}))
                    }
                );
                const wf = flow(s1, sBranch);

                // Standalone toDot with default options
                const defaultDot = toDot(wf);
                expect(defaultDot).to.include('digraph Workflow {');
                expect(defaultDot).to.include('rankdir=TB;');
                expect(defaultDot).to.include('⏱️ 2000ms');
                expect(defaultDot).to.include('⏪ saga');
                expect(defaultDot).to.include('shape=box');
                expect(defaultDot).to.include('shape=diamond');
                expect(defaultDot).to.include('[label="first-step"]');
                expect(defaultDot).to.include('[label="next"]');
                expect(defaultDot).to.include('[label="when:pos"]');
                expect(defaultDot).to.include('[label="when:neg"]');

                // Standalone toDot on a single step
                const singleDot = toDot(s1, {graphName: 'SingleStepGraph', direction: 'LR'});
                expect(singleDot).to.include('digraph SingleStepGraph {');
                expect(singleDot).to.include('rankdir=LR;');
                expect(singleDot).to.include('step1');
            });

            it('should format retry badge with auto when retries and maxRetries are undefined', () => {
                const s = Step.create('retryAuto', () => ({})).onFail({} as any);
                const mermaid = toMermaid(s);
                expect(mermaid).to.include('retry(auto)');
            });
        });
    });

});
