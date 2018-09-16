import { Component } from '../component';

/**
 * Retains a pool of Components for re-use.
 * @type {Component[]}
 * @private
 */
export const recyclerComponents = [];


/**
 * Create a component. Normalizes differences between PFC's and classful
 * Components.
 * @param {function} Ctor The constructor of the component to create
 * @param {object} props The initial props of the component
 * @param {object} context The initial context of the component
 * @returns {import('../component').Component}
 */
export function createComponent(Ctor, props, context) {
	let inst, i = recyclerComponents.length;

    // 非纯函数组件
	if (Ctor.prototype && Ctor.prototype.render) {
		inst = new Ctor(props, context);
		Component.call(inst, props, context);
    }
    // 纯函数组件
	else {
		inst = new Component(props, context);
		inst.constructor = Ctor;
		inst.render = doRender;
	}


	while (i--) {
		if (recyclerComponents[i].constructor===Ctor) {
            // 基于之前回收的组件实例的dom进行处理
            inst.nextBase = recyclerComponents[i].nextBase;
            
			recyclerComponents.splice(i, 1);
			return inst;
		}
	}

	return inst;
}


/** The `.render()` method for a PFC backing instance. */
function doRender(props, state, context) {
	return this.constructor(props, context);
}
