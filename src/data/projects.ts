export interface Project {
	name: string;
	status: string;
	summary: string;
	technologies: string[];
	role: string;
	details: string[];
}

export const projects: Project[] = [
	{
		name: 'FastStore',
		status: '开发中',
		summary: '用于学习和实践客户端 / 服务端开发的文件存储项目。',
		technologies: ['C++', 'Qt', 'TCP', 'Linux', 'CMake'],
		role: '个人开发项目，围绕客户端、服务器、通信协议和工程结构持续实现与整理。',
		details: [
			'逐步实现文件传输、协议处理和客户端交互等功能。',
			'实践 Qt 客户端与 TCP 网络通信。',
			'关注异步交互、QObject 生命周期、资源管理和错误处理。',
		],
	},
	{
		name: '高并发 HTTP Server',
		status: '学习项目',
		summary: '用于学习 Linux 网络编程、epoll、线程池以及高并发服务器架构的实验项目。',
		technologies: ['C++', 'Linux', 'epoll', 'TCP/IP', 'ThreadPool', 'HTTP'],
		role: '围绕服务器开发与相关学习方向，进行网络模型、请求处理和并发机制实验。',
		details: [
			'实践 epoll 与 Linux TCP 网络编程。',
			'学习多线程、线程池和 HTTP 请求处理。',
			'用于高并发服务器架构的实验与总结，不定位为生产级服务器。',
		],
	},
	{
		name: 'FreeKill Server',
		status: '实践中',
		summary: '围绕游戏服务器运行环境开展的部署与网络服务实践。',
		technologies: ['Linux', '网络服务'],
		role: '主要进行 Linux 环境下的编译、运行、服务器环境配置和远程访问验证。',
		details: [
			'在 Linux 环境中进行项目编译与运行。',
			'实践游戏服务器相关的网络服务和运行环境配置。',
			'使用 FRP 验证远程访问方案，作为部署与网络配置经验的一部分。',
		],
	},
];
