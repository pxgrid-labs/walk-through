import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as MW from 'meshwalk';
import { init as initRecast, Crowd } from '@recast-navigation/core';
import { threeToSoloNavMesh, NavMeshHelper } from '@recast-navigation/three';
import { Joystick, Button } from 'screen-gamepad';

const container = document.getElementById( 'app' );
const loadingEl = document.getElementById( 'loading' );

const CAPSULE_RADIUS = 0.3;
const CAPSULE_HEIGHT = 2.0;
const MOVE_SPEED = 4.0;
const CAMERA_ROTATE_SPEED = 2.0; // 右スティック全倒し時のカメラ回転速度[rad/秒]
// カプセルの足元（＝キャラクターコントローラの原点）のスタート位置。
// もとのカプセルは中心を SPAWN_POSITION.y + CAPSULE_HEIGHT/2 に置いていたので、
// 足元は SPAWN_POSITION.y になる。
const SPAWN_POSITION = new THREE.Vector3( - 10, 0.1, - 5 );

// --- Renderer ---
const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
container.appendChild( renderer.domElement );

// --- Scene & Camera ---
const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x1a1a1a );

const camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.01, 100 );

// --- Environment (PBR ライティング) ---
const pmremGenerator = new THREE.PMREMGenerator( renderer );
scene.environment = pmremGenerator.fromScene( new RoomEnvironment(), 0.04 ).texture;
// 環境光(IBL)全体の強さ。白飛びするので 1.0 から下げて抑える。
scene.environmentIntensity = 0.65;

// 補助的な直接光
const dirLight = new THREE.DirectionalLight( 0xffffff, 1.0 );
dirLight.position.set( 5, 10, 7.5 );
scene.add( dirLight );
scene.add( new THREE.AmbientLight( 0xffffff, 0.2 ) );

// --- Physics world (MeshWalk) ---
const world = new MW.World();
const staticBody = new MW.StaticBody();
world.add( staticBody );

// --- Character（カプセル） ---
// CharacterController の原点は足元。表示用カプセルは holder の中で半分だけ上へずらす。
const playerHolder = new THREE.Object3D();
scene.add( playerHolder );

const capsuleLength = CAPSULE_HEIGHT - CAPSULE_RADIUS * 2;
const capsule = new THREE.Mesh(
	new THREE.CapsuleGeometry( CAPSULE_RADIUS, capsuleLength, 8, 16 ),
	new THREE.MeshStandardMaterial( { color: 0x4488ff, roughness: 0.4, metalness: 0.0 } )
);
capsule.position.y = CAPSULE_HEIGHT * 0.5;
playerHolder.add( capsule );

const playerController = new MW.CharacterController( {
	radius: CAPSULE_RADIUS,
	height: CAPSULE_HEIGHT,
	jumpDuration: .3,
} );
playerController.teleport( SPAWN_POSITION );
world.add( playerController );

// --- Ground（基本の地面コライダー） ---
// three.js で作った素の板をベースの地面にする。同期生成なので最初のフレームから
// コリジョンが存在し、body.glb のロードを待つ間もキャラが落下しない。
// この板の上に、あとから body.glb を追加コライダーとして重ねて登録する。
const GROUND_SIZE = 30;
const ground = new THREE.Mesh(
	new THREE.PlaneGeometry( GROUND_SIZE, GROUND_SIZE, 10, 10 ),
	new THREE.MeshBasicMaterial( { color: 0xffffff, wireframe: true } )
);
ground.rotation.x = - 90 * THREE.MathUtils.DEG2RAD;
scene.add( ground );
staticBody.addFromObject( ground );

// --- Ceiling（カメラの天井抜け防止コライダー） ---
// 天井付近に「下向きを正面（法線 -Y）」にした plane を置く。三人称カメラの衝突判定
// （rayIntersect）がこの面に当たり、カメラが天井を突き抜けない。描画はしない
// （scene に add せず addFromObject で当たり判定だけ登録）。広さは床と同じ。
// 法線が下向きなので _checkGround では床扱いされない。高さは CEILING_Y で微調整可。
const CEILING_Y = 5.8;
const ceiling = new THREE.Mesh( new THREE.PlaneGeometry( GROUND_SIZE, GROUND_SIZE, 10, 10 ) );
ceiling.rotation.x = 90 * THREE.MathUtils.DEG2RAD; // 法線を下向きにする
ceiling.position.y = CEILING_Y;
staticBody.addFromObject( ceiling );

// --- Input & Camera Controls (三人称) ---
// ThirdPersonCameraControls は構築時の camera.position から軌道（距離・仰角・方位）を
// 決める。原点基準で「やや後方・上」にカメラを置いておくことで、以降キャラを追従しても
// 肩越しの見やすい距離感が保たれる。未設定だと距離0で真上を向いて何も映らない。
camera.position.set( 0, 0, - 2 );
playerHolder.position.copy( SPAWN_POSITION );

const keyInputControl = new MW.KeyboardControls();
const tpsCameraControls = new MW.ThirdPersonCameraControls(
	camera,
	playerHolder,
	world,
	renderer.domElement
);
tpsCameraControls.maxDistance = 3.5;
window.playerController=playerController
window.tpsCameraControls=tpsCameraControls

// タッチ端末向け仮想パッド（後段のブロックで生成。デスクトップでは null のまま）。
let moveJoystick = null;
let lookJoystick = null;

// キー入力とカメラの向きから、望む水平移動速度ベクトルを作って move() へ渡す。
const _moveDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3( 0, 1, 0 );
const applyMove = () => {

	const input = keyInputControl.inputVector;
	playerController.move(
		_moveDir
			.set( input.x, 0, - input.y )
			.applyAxisAngle( _yAxis, tpsCameraControls.frontAngle )
			.multiplyScalar( MOVE_SPEED )
	);

};

// 左スティックの傾き（各軸 -1〜1）から水平移動速度を作る。傾き量がそのまま速度倍率
// になるアナログ移動。キーボードと同じくカメラの向き（frontAngle）基準にする。
const applyTouchMove = () => {

	playerController.move(
		_moveDir
			.set( moveJoystick.x, 0, - moveJoystick.y )
			.applyAxisAngle( _yAxis, tpsCameraControls.frontAngle )
			.multiplyScalar( MOVE_SPEED )
	);

};

keyInputControl.addEventListener( 'movekeyon', applyMove );
keyInputControl.addEventListener( 'movekeychange', applyMove );
keyInputControl.addEventListener( 'movekeyoff', () => playerController.move( _moveDir.set( 0, 0, 0 ) ) );
keyInputControl.addEventListener( 'jumpkeypress', () => playerController.jump() );

// 移動中はカメラの向きに追従させる（'update' は tpsCameraControls.update() が発火）。
// 左スティック操作中はそちら、そうでなければキーボード入力を基準にする。
tpsCameraControls.addEventListener( 'update', () => {

	if ( moveJoystick && moveJoystick.isActive ) {

		applyTouchMove();

	} else if ( playerController.isRunning ) {

		applyMove();

	}

} );

// --- Auto Pilot（navMesh 上をエージェントが経路探索し、キャラをそこへ追従させる） ---
// 目的地（ワールド座標）。ボタンでここへ自動移動する。
// azimuth: 到着時にカメラを向ける方位角[rad]（CameraControls.azimuthAngle）
const DESTINATIONS = [
	{ label: 'キャッシャー', position: new THREE.Vector3( - 9.75, 0.09, - 2.64 ), azimuth: Math.PI / 2 },
	{ label: 'カゴ', position: new THREE.Vector3( - 10.75, 0.09, 0.78 ), azimuth: Math.PI / 2 },
	{ label: 'カート', position: new THREE.Vector3( - 10.42, 0.09, 5.42 ), azimuth: Math.PI / 2 },
	{ label: '洗剤', position: new THREE.Vector3( - 5.12, 0.09, 1.93 ), azimuth: 0 },
];

let crowd = null; // navMesh 生成後に初期化
let navMeshHelper = null; // navMesh の可視化ヘルパー（生成後に代入・チェックボックスで表示切替）
let agent = null; // 経路探索エージェント（オートパイロット中のみ存在）
let currentDestination = null; // 現在オートパイロット中の目的地（到着時のカメラ向き変更に使う）
let autoPilotFloorY = SPAWN_POSITION.y; // オートパイロット中に固定する足元の高さ（navMesh の浮き分を無視）
const goalPosition = new THREE.Vector3();
const ARRIVE_DISTANCE = 0.4; // 目的地にこの距離まで近づいたら停止[m]

// ワールド座標を navMesh 上の最近点へスナップする。
const getClosestNavMeshPoint = ( position ) => {

	const result = crowd.navMeshQuery.findClosestPoint( position );
	return result.success ? result.point : null;

};

// 指定目的地へオートパイロット開始。
const navigateTo = ( destination ) => {

	if ( ! crowd ) return;

	if ( agent === null ) {

		agent = crowd.addAgent( getClosestNavMeshPoint( playerController.position ) ?? playerController.position, {
			radius: CAPSULE_RADIUS,
			height: CAPSULE_HEIGHT,
			maxAcceleration: 1e10,
			maxSpeed: MOVE_SPEED,
			collisionQueryRange: 0.5,
			pathOptimizationRange: 0.0,
			separationWeight: 1.0,
		} );

	}

	const from = getClosestNavMeshPoint( playerController.position );
	const to = getClosestNavMeshPoint( destination.position );
	if ( ! to ) return;

	currentDestination = destination;
	autoPilotFloorY = playerController.position.y; // 開始時の床の高さを固定値にする
	goalPosition.set( to.x, to.y, to.z );
	agent.teleport( from );
	agent.requestMoveTarget( to );

};

// 手動操作されたらオートパイロットを解除する。
const cancelAutoPilot = () => {

	if ( agent === null ) return;
	crowd.removeAgent( agent );
	agent = null;
	currentDestination = null;

};

keyInputControl.addEventListener( 'movekeyon', cancelAutoPilot );
keyInputControl.addEventListener( 'jumpkeypress', cancelAutoPilot );

// --- On-screen gamepad（タッチ端末向け仮想パッド） ---
// 左スティック=移動 / 右スティック=カメラ回転 / ボタン=ジャンプ。
// 主入力がタッチ（pointer: coarse）の端末でのみ表示する。右スティックの回転は
// 「押しっぱなし」を拾うため描画ループ内で毎フレーム適用する（下部の render loop 参照）。
if ( window.matchMedia( '( pointer: coarse )' ).matches ) {

	moveJoystick = new Joystick();
	Object.assign( moveJoystick.domElement.style, { left: '24px', bottom: '24px', top: 'auto' } );
	document.body.appendChild( moveJoystick.domElement );
	moveJoystick.addEventListener( 'change', () => {

		cancelAutoPilot();

		if ( moveJoystick.x === 0 && moveJoystick.y === 0 ) {

			playerController.move( _moveDir.set( 0, 0, 0 ) );

		} else {

			applyTouchMove();

		}

	} );

	lookJoystick = new Joystick();
	Object.assign( lookJoystick.domElement.style, { right: '24px', bottom: '24px', top: 'auto' } );
	document.body.appendChild( lookJoystick.domElement );

	const jumpButton = new Button( { size: 72 } );
	// 右スティック（right:24 / bottom:24 / 128px、中心は右から88px）の真上に、少し間隔を空けて置く。
	Object.assign( jumpButton.domElement.style, { right: '52px', bottom: '168px', color: 'rgba( 68, 136, 255, 0.75 )' } );
	document.body.appendChild( jumpButton.domElement );
	jumpButton.addEventListener( 'active', () => {

		cancelAutoPilot();
		playerController.jump();

	} );

}

// 毎フレーム: エージェントの進みに合わせてキャラを追従・向き付けし、到着したら停止。
const _agentDir = new THREE.Vector2();
const _agentPos = new THREE.Vector3();
const checkAutoPilotState = () => {

	if ( agent === null ) return;

	const position = agent.position();
	_agentPos.set( position.x, position.y, position.z );

	if ( goalPosition.distanceTo( _agentPos ) < ARRIVE_DISTANCE ) {

		// 到着: 目的地ごとの方位へカメラを滑らかに向ける（CameraControls の遷移アニメ）。
		// normalizeRotations() で最短角に保ち、180度以上の遠回り回転をさせない。
		if ( currentDestination ) {

			tpsCameraControls.rotateAzimuthTo( currentDestination.azimuth, true );
			tpsCameraControls.normalizeRotations();

		}
		currentDestination = null;

		cancelAutoPilot();
		playerController.move( _moveDir.set( 0, 0, 0 ) );
		return;

	}

	// エージェントの速度から向きを作って move()（向き付け）＋ 位置はエージェントへスナップ。
	const velocity = agent.velocity();
	if ( Math.abs( velocity.x ) > 1e-10 || Math.abs( velocity.z ) > 1e-10 ) {

		_agentDir.set( - velocity.z, - velocity.x ).normalize();
		const angle = _agentDir.angle();
		playerController.move( _moveDir.set( - Math.sin( angle ), 0, - Math.cos( angle ) ) );

		// オートパイロット中はカメラを乗っ取り、進行方向を正面（カメラ後方＝進行方向）にする。
		// azimuth = angle でカメラ前方ベクトルが進行方向に一致する。毎フレーム目標を更新し、
		// normalizeRotations() で最短角に保って滑らかに追従させる。
		tpsCameraControls.rotateAzimuthTo( angle, true );
		tpsCameraControls.normalizeRotations();

	}

	// navMesh は body.glb より少し浮くので、y は開始時の床高さに据え置き、水平移動だけ反映する
	// （そのまま agent の y を使うとキャラが浮き、停止時に落ちてカメラがガタつく）。
	playerController.teleport( _agentPos.set( position.x, autoPilotFloorY, position.z ) );

};

// 左上のオートパイロット用ボタン UI。
const autopilotUI = document.createElement( 'div' );
Object.assign( autopilotUI.style, {
	position: 'fixed',
	top: '12px',
	left: '12px',
	display: 'flex',
	flexDirection: 'column',
	gap: '6px',
	zIndex: '10',
} );

for ( const destination of DESTINATIONS ) {

	const button = document.createElement( 'button' );
	button.textContent = destination.label;
	Object.assign( button.style, {
		padding: '8px 14px',
		font: '13px system-ui, sans-serif',
		color: '#fff',
		background: 'rgba( 0, 0, 0, 0.55 )',
		border: '1px solid rgba( 255, 255, 255, 0.35 )',
		borderRadius: '6px',
		cursor: 'pointer',
		textAlign: 'left',
	} );
	button.disabled = true;
	button.style.opacity = '0.5';
	button.addEventListener( 'click', () => navigateTo( destination ) );
	destination.button = button;
	autopilotUI.appendChild( button );

}

// navMesh の表示 / 非表示を切り替えるチェックボックス。初期は非表示。
const navMeshToggle = document.createElement( 'label' );
Object.assign( navMeshToggle.style, {
	display: 'flex',
	alignItems: 'center',
	gap: '5px',
	marginTop: '6px',
	padding: '0 2px',
	font: '11px system-ui, sans-serif',
	color: 'rgba( 255, 255, 255, 0.5 )',
	cursor: 'pointer',
	userSelect: 'none',
} );

const navMeshCheckbox = document.createElement( 'input' );
navMeshCheckbox.type = 'checkbox';
navMeshCheckbox.checked = false;
navMeshCheckbox.style.cursor = 'pointer';
navMeshCheckbox.addEventListener( 'change', () => {

	if ( navMeshHelper ) navMeshHelper.visible = navMeshCheckbox.checked;

} );

navMeshToggle.appendChild( navMeshCheckbox );
navMeshToggle.appendChild( document.createTextNode( 'navMesh を表示' ) );
autopilotUI.appendChild( navMeshToggle );

document.body.appendChild( autopilotUI );

// --- Loaders (Draco 対応) ---
// three が同梱する glTF 用最適化デコーダを bundler 経由で参照する（three.js 推奨）。
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath( DRACO_GLTF_CONFIG );

const loader = new GLTFLoader();
loader.setDRACOLoader( dracoLoader );

const onProgress = ( event ) => {

	if ( event.total ) {

		const percent = Math.floor( ( event.loaded / event.total ) * 100 );
		loadingEl.textContent = `Loading… ${ percent }%`;

	}

};

// store.glb: 表示のみ（コリジョンには使わない）
loader.load(
	'store.glb',
	( gltf ) => {

		scene.add( gltf.scene );
		loadingEl.style.display = 'none';

	},
	onProgress,
	( error ) => {

		console.error( error );
		loadingEl.textContent = 'モデルの読み込みに失敗しました';

	}
);

// glb の量子化（KHR_mesh_quantization: 正規化整数の頂点）を、素の Float32・
// ワールド座標の Mesh へ焼き直す。recast の getPositionsAndIndices は position 配列を
// 生値のまま読むため、正規化整数のままだと巨大スケールの壊れた navMesh になる。
// fromBufferAttribute は正規化を復元してくれるので、それを介して取り出す。
function bakeToWorldMesh( object ) {

	object.updateWorldMatrix( true, true );

	const positions = [];
	const v = new THREE.Vector3();

	object.traverse( ( child ) => {

		if ( ! child.isMesh ) return;

		const position = child.geometry.attributes.position;
		const index = child.geometry.index;

		const pushVertex = ( i ) => {

			v.fromBufferAttribute( position, i ).applyMatrix4( child.matrixWorld );
			positions.push( v.x, v.y, v.z );

		};

		if ( index ) {

			for ( let i = 0; i < index.count; i ++ ) pushVertex( index.getX( i ) );

		} else {

			for ( let i = 0; i < position.count; i ++ ) pushVertex( i );

		}

	} );

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	return new THREE.Mesh( geometry );

}

// body.glb: 追加コライダー（表示せず当たり判定専用）＋ navMesh のソース。
// meshwalk 1.1.0 は量子化に対応済みなのでコライダーはそのまま addFromObject でよい。
// navMesh は recast（threeToSoloNavMesh）で生成し、ひとまず NavMeshHelper で表示する。
loader.load(
	'body.glb',
	async ( gltf ) => {

		staticBody.addFromObject( gltf.scene );

		// recast の wasm を初期化してから navMesh を生成する。
		await initRecast();

		const navSource = bakeToWorldMesh( gltf.scene );

		// navMesh の生成設定。recast の walkableRadius / walkableClimb はセル単位なので
		// メートル指定を cs / ch で割って渡す。
		// - walkableRadius: エージェント半径ぶん歩行領域を内側に削る（実削り幅 = cells * cs）。
		//   半径の 2 倍より狭い通路は navMesh から除外される。
		// - walkableClimb: 登れる段差の最大高さ（実高さ = cells * ch）。これ以下の段差は
		//   繋がった歩行面として扱い、これを超える段差は縁（通れない）になる。
		const NAV_CELL_SIZE = 0.15;        // cs: 水平解像度
		const NAV_CELL_HEIGHT = 0.2;       // ch: 垂直解像度
		const NAV_WALKABLE_RADIUS = 0.1;   // エージェント半径[m]
		const NAV_MAX_CLIMB = 0.2;         // 登れる段差の最大高さ[m]
		const result = threeToSoloNavMesh( [ navSource ], {
			cs: NAV_CELL_SIZE,
			ch: NAV_CELL_HEIGHT,
			walkableRadius: Math.round( NAV_WALKABLE_RADIUS / NAV_CELL_SIZE ),
			walkableClimb: Math.round( NAV_MAX_CLIMB / NAV_CELL_HEIGHT ),
		} );

		if ( ! result.success ) {

			console.error( 'nav mesh の生成に失敗:', result.error );
			return;

		}

		navMeshHelper = new NavMeshHelper( result.navMesh, {} );
		navMeshHelper.visible = navMeshCheckbox.checked; // 初期は非表示（チェックボックスに追従）
		scene.add( navMeshHelper );

		// navMesh が用意できたので Crowd を初期化し、オートパイロットボタンを有効化する。
		crowd = new Crowd( result.navMesh, { maxAgents: 1, maxAgentRadius: 0.5 } );
		for ( const destination of DESTINATIONS ) {

			destination.button.disabled = false;
			destination.button.style.opacity = '1';

		}

	},
	undefined,
	( error ) => {

		console.error( error );

	}
);

// --- Resize ---
window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );

// --- Render loop ---
const timer = new THREE.Timer();
timer.connect( document );

renderer.setAnimationLoop( () => {

	timer.update();
	const delta = timer.getDelta();

	world.update( delta );

	// オートパイロット: エージェントを進め、キャラをその位置へ追従させる。
	if ( crowd ) crowd.update( delta );
	checkAutoPilotState();

	// 物理(Body)から表示メッシュへ transform を同期する。
	playerHolder.position.copy( playerController.position );
	playerHolder.quaternion.copy( playerController.quaternion );

	// 右スティック: 傾き量 × 速度 × delta でカメラを連続回転（方位・仰角）。
	if ( lookJoystick && ( lookJoystick.x !== 0 || lookJoystick.y !== 0 ) ) {

		tpsCameraControls.rotate(
			lookJoystick.x * CAMERA_ROTATE_SPEED * delta,
			- lookJoystick.y * CAMERA_ROTATE_SPEED * delta,
			false
		);

	}

	tpsCameraControls.update( delta );
	renderer.render( scene, camera );

} );
