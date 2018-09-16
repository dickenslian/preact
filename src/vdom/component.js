import { SYNC_RENDER, NO_RENDER, FORCE_RENDER, ASYNC_RENDER, ATTR_KEY } from '../constants';
import options from '../options';
import { extend, applyRef } from '../util';
import { enqueueRender } from '../render-queue';
import { getNodeProps } from './index';
import { diff, mounts, diffLevel, flushMounts, recollectNodeTree, removeChildren } from './diff';
import { createComponent, recyclerComponents } from './component-recycler';
import { removeNode } from '../dom/index';

/**
 * Set a component's `props` and possibly re-render the component
 * @param {import('../component').Component} component The Component to set props on
 * @param {object} props The new props
 * @param {number} renderMode Render options - specifies how to re-render the component
 * @param {object} context The new context
 * @param {boolean} mountAll Whether or not to immediately mount all components
 */
export function setComponentProps(component, props, renderMode, context, mountAll) {
	if (component._disable) return;
	component._disable = true;

	component.__ref = props.ref;
	component.__key = props.key;
	delete props.ref;
	delete props.key;

    // 生命周期
	if (typeof component.constructor.getDerivedStateFromProps === 'undefined') {
		if (!component.base || mountAll) {
			if (component.componentWillMount) component.componentWillMount();
		}
		else if (component.componentWillReceiveProps) {
			component.componentWillReceiveProps(props, context);
		}
	}

	if (context && context!==component.context) {
		if (!component.prevContext) component.prevContext = component.context;
		component.context = context;
	}

	if (!component.prevProps) component.prevProps = component.props;
	component.props = props;

	component._disable = false;

	if (renderMode!==NO_RENDER) {
		if (renderMode===SYNC_RENDER || options.syncComponentUpdates!==false || !component.base) {
			renderComponent(component, SYNC_RENDER, mountAll);
		}
		else {
            // setState
			enqueueRender(component);
		}
	}

	applyRef(component.__ref, component);
}



/**
 * Render a Component, triggering necessary lifecycle events and taking
 * High-Order Components into account.
 * @param {import('../component').Component} component The component to render
 * @param {number} [renderMode] render mode, see constants.js for available options.
 * @param {boolean} [mountAll] Whether or not to immediately mount all components
 * @param {boolean} [isChild] ?
 * @private
 */
export function renderComponent(component, renderMode, mountAll, isChild) {
	if (component._disable) return;

	let props = component.props,
		state = component.state,
		context = component.context,
		previousProps = component.prevProps || props,
		previousState = component.prevState || state,
        previousContext = component.prevContext || context,
        
		isUpdate = component.base,
		nextBase = component.nextBase,
		initialBase = isUpdate || nextBase,
        initialChildComponent = component._component,
        
		skip = false,
		snapshot = previousContext,
		rendered, inst, cbase;

    // 生命周期
	if (component.constructor.getDerivedStateFromProps) {
		state = extend(
            extend({}, state), 
            component.constructor.getDerivedStateFromProps(props, state));
		component.state = state;
	}

    // 如果是组件更新，调用生命周期函数
    // isUpdate = component.base
	// if updating
	if (isUpdate) {
		component.props = previousProps;
		component.state = previousState;
		component.context = previousContext;
		if (renderMode!==FORCE_RENDER
			&& component.shouldComponentUpdate
			&& component.shouldComponentUpdate(props, state, context) === false) {
			skip = true;
		}
		else if (component.componentWillUpdate) {
			component.componentWillUpdate(props, state, context);
		}
		component.props = props;
		component.state = state;
		component.context = context;
	}

    component.prevProps = component.prevState = component.prevContext = component.nextBase = null;
    
    // 只有_dirty为false才会被放入更新队列
	component._dirty = false;

	if (!skip) {
        // vdom
		rendered = component.render(props, state, context);

		// context to pass to the child, can be updated via (grand-)parent component
		if (component.getChildContext) {
			context = extend(extend({}, context), component.getChildContext());
		}

		if (isUpdate && component.getSnapshotBeforeUpdate) {
			snapshot = component.getSnapshotBeforeUpdate(previousProps, previousState);
		}

		let childComponent = rendered && rendered.nodeName,
			toUnmount, base;

        // 高阶组件，高阶组件才需要_component，_component里面又有_parentComponent属性
		if (typeof childComponent==='function') {
			// set up high order component link
			let childProps = getNodeProps(rendered);
			inst = initialChildComponent;

			if (inst && inst.constructor===childComponent && childProps.key==inst.__key) {
                // 同步更新，又会再调用renderComponent
				setComponentProps(inst, childProps, SYNC_RENDER, context, false);
			}
			else {
				toUnmount = inst;

                // 分创建实例和属性赋值2个步骤
				component._component = inst = createComponent(childComponent, childProps, context);
                inst.nextBase = inst.nextBase || nextBase;
                // _parentComponent指向高阶组件
                inst._parentComponent = component;
                // NO_RENDER不进行渲染
                setComponentProps(inst, childProps, NO_RENDER, context, false);
                // 递归调用自己
				renderComponent(inst, SYNC_RENDER, mountAll, true);
			}

			base = inst.base;
		}
		else {
            /*
                isUpdate = component.base,
		        nextBase = component.nextBase,
		        initialBase = isUpdate || nextBase,
                initialChildComponent = component._component,
             */
			cbase = initialBase;

            // destroy high order component link
            // 不是高阶组件，不需要_component属性
			toUnmount = initialChildComponent;
			if (toUnmount) {
				cbase = component._component = null;
			}

			if (initialBase || renderMode===SYNC_RENDER) {
				if (cbase) cbase._component = null;
				base = diff(cbase, rendered, context, mountAll || !isUpdate, initialBase && initialBase.parentNode, true);
			}
		}

		if (initialBase && base!==initialBase && inst!==initialChildComponent) {
			let baseParent = initialBase.parentNode;
			if (baseParent && base!==baseParent) {
				baseParent.replaceChild(base, initialBase);

				if (!toUnmount) {
					initialBase._component = null;
					recollectNodeTree(initialBase, false);
				}
			}
		}

		if (toUnmount) {
			unmountComponent(toUnmount);
		}

		component.base = base;
		if (base && !isChild) {
			let componentRef = component,
				t = component;
			while ((t=t._parentComponent)) {
                // 所有高阶组件的base都等于组件的base
				(componentRef = t).base = base;
            }
            // base的_component等于高阶组件
			base._component = componentRef;
			base._componentConstructor = componentRef.constructor;
		}
	}

	if (!isUpdate || mountAll) {
		mounts.unshift(component);
	}
	else if (!skip) {
		// Ensure that pending componentDidMount() hooks of child components
		// are called before the componentDidUpdate() hook in the parent.
		// Note: disabled as it causes duplicate hooks, see https://github.com/developit/preact/issues/750
		// flushMounts();
        // 生命周期
		if (component.componentDidUpdate) {
			component.componentDidUpdate(previousProps, previousState, snapshot);
		}
		if (options.afterUpdate) options.afterUpdate(component);
	}

	while (component._renderCallbacks.length) component._renderCallbacks.pop().call(component);

	if (!diffLevel && !isChild) flushMounts();
}



/**
 * Apply the Component referenced by a VNode to the DOM.
 * @param {import('../dom').PreactElement} dom The DOM node to mutate
 * @param {import('../vnode').VNode} vnode A Component-referencing VNode
 * @param {object} context The current context
 * @param {boolean} mountAll Whether or not to immediately mount all components
 * @returns {import('../dom').PreactElement} The created/mutated element
 * @private
 */
export function buildComponentFromVNode(dom, vnode, context, mountAll) {
	let c = dom && dom._component,
		originalComponent = c,
		oldDom = dom,
		isDirectOwner = c && dom._componentConstructor===vnode.nodeName,
        isOwner = isDirectOwner,
        // 获取属性值，包括默认属性值
        props = getNodeProps(vnode);
    
    // 针对高阶组件，一直找到最顶层
	while (c && !isOwner && (c=c._parentComponent)) {
		isOwner = c.constructor===vnode.nodeName;
	}

	if (c && isOwner && (!mountAll || c._component)) {
        // 异步更新
        setComponentProps(c, props, ASYNC_RENDER, context, mountAll);
        
        // dom节点存在base里面
		dom = c.base;
    }
    // 创建组件
	else {
        // 组件替换
		if (originalComponent && !isDirectOwner) {
			unmountComponent(originalComponent);
			dom = oldDom = null;
		}

        // 组件创建的起点，此时还没有_component
		c = createComponent(vnode.nodeName, props, context);
		if (dom && !c.nextBase) {
			c.nextBase = dom;
			// passing dom/oldDom as nextBase will recycle it if unused, so bypass recycling on L229:
			oldDom = null;
        }
        
        // 创建dom节点，关联dom与component(setComponentProps里面调用的renderComponent的时候关联)
		setComponentProps(c, props, SYNC_RENDER, context, mountAll);
		dom = c.base;

		if (oldDom && dom!==oldDom) {
			oldDom._component = null;
			recollectNodeTree(oldDom, false);
		}
	}

	return dom;
}



/**
 * Remove a component from the DOM and recycle it.
 * @param {import('../component').Component} component The Component instance to unmount
 * @private
 */
export function unmountComponent(component) {
	if (options.beforeUnmount) options.beforeUnmount(component);

	let base = component.base;

	component._disable = true;

	if (component.componentWillUnmount) component.componentWillUnmount();

	component.base = null;

	// recursively tear down & recollect high-order component children:
	let inner = component._component;
	if (inner) {
		unmountComponent(inner);
	}
	else if (base) {
		if (base[ATTR_KEY] && base[ATTR_KEY].ref) base[ATTR_KEY].ref(null);

		component.nextBase = base;

		removeNode(base);
		recyclerComponents.push(component);

		removeChildren(base);
	}

	applyRef(component.__ref, null);
}
