import type { MessageCatalog } from '../messages.types';

/**
 * Simplified Chinese (`zh-CN`) message catalog (T9.2).
 *
 * Typed as {@link MessageCatalog}, so it MUST mirror every key in
 * `../en/messages.ts`; TypeScript fails the build if a key is missing
 * (satisfies T9.2 acceptance). Runtime fallback chain is `zh-CN → en`
 * (see `../index.ts`).
 *
 * Interpolation tokens (e.g. `{min}`, `{max}`) are preserved verbatim.
 */
export const zhCN: MessageCatalog = {
  common: {
    appName: '雪上学校',
    portal: '教练门户',
    loading: '加载中…',
    save: '保存',
    cancel: '取消',
    edit: '编辑',
    delete: '删除',
    confirm: '确认',
    back: '返回',
    next: '下一步',
    submit: '提交',
    search: '搜索',
    yes: '是',
    no: '否',
    language: '语言',
    languageEnglish: '英语',
    languageChinese: '简体中文',
    statusPending: '待审核',
    statusApproved: '已通过',
    statusRejected: '已拒绝',
    statusDeactivated: '已停用',
  },
  auth: {
    signInTitle: '登录',
    signUpTitle: '创建账户',
    emailLabel: '电子邮箱',
    passwordLabel: '密码',
    signInButton: '登录',
    signUpButton: '注册',
    signOut: '退出登录',
    forgotPassword: '忘记密码？',
    verifyEmailTitle: '验证您的邮箱',
    verifyEmailBody: '我们已向您的邮箱发送了验证链接，请打开以激活您的账户。',
    resendVerification: '重新发送验证邮件',
    emailNotVerified: '请先验证您的电子邮箱地址以继续。',
  },
  profile: {
    title: '我的资料',
    displayName: '显示名称',
    bio: '个人简介',
    bioPlaceholder: '向合作伙伴介绍您的经验和教学风格…',
    preferredLanguage: '首选语言',
    dateOfBirth: '出生日期',
    certifications: '认证资格',
    disciplines: '项目',
    teachingLocations: '教学地点',
    courseLevels: '课程级别',
    photo: '头像',
    uploadPhoto: '上传头像',
    saveSuccess: '您的资料已保存。',
    saveError: '无法保存您的资料，请重试。',
  },
  error: {
    unauthorized: '您必须登录后才能执行此操作。',
    forbidden: '您没有执行此操作的权限。',
    notFound: '未找到请求的项目。',
    validation: '您提供的部分信息无效。',
    conflict: '此操作与记录的当前状态冲突。',
    rateLimited: '请求过于频繁，请稍后再试。',
    internal: '我们这边出现了问题，请稍后再试。',
    emailNotVerified: '您的电子邮箱地址尚未验证。',
    profileNotApproved: '您的资料尚未通过审核。',
  },
  validation: {
    required: '此字段为必填项。',
    email: '请输入有效的电子邮箱地址。',
    minLength: '请至少输入 {min} 个字符。',
    maxLength: '请输入不超过 {max} 个字符。',
    invalidDate: '请输入有效的日期。',
    invalidLanguage: '请选择受支持的语言。',
    invalidUuid: '提供的标识符无效。',
  },
  emptyState: {
    noCertifications: '尚未添加认证资格。',
    noDisciplines: '尚未选择项目。',
    noLocations: '尚未选择教学地点。',
    noResults: '未找到结果。',
  },
  notification: {
    approved: {
      subject: '您的教练资料已通过审核',
      greeting: '您好',
      body: '好消息——您的教练资料已通过审核。您现在可以登录门户，您的资料已对合作伙伴可见。',
      reasonLabel: '原因',
      linkLabel: '门户',
      signoff: '谢谢，\n雪上学校团队',
    },
    rejected: {
      subject: '关于您的教练申请的更新',
      greeting: '您好',
      body: '感谢您的申请。经审核，您的教练资料暂未通过。',
      reasonLabel: '原因',
      linkLabel: '门户',
      signoff: '谢谢，\n雪上学校团队',
    },
    deactivated: {
      subject: '您的教练资料已被停用',
      greeting: '您好',
      body: '您的教练资料已被停用，合作伙伴将无法看到。如有疑问，请联系学校。',
      reasonLabel: '原因',
      linkLabel: '门户',
      signoff: '谢谢，\n雪上学校团队',
    },
  },
};

export default zhCN;
